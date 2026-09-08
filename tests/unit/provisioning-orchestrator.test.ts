import { describe, expect, it, vi } from 'vitest';
import {
  ExternalProvisioningBlock,
  ProvisioningOrchestrator,
  TENANT_PROVISIONING_STEPS,
  type ProvisioningExecutionStatus,
  type ProvisioningOperation,
  type ProvisioningRunStore,
  type ProvisioningStepSnapshot,
  type TenantProvisioningStep,
} from '@tryggsignal/integrations';

class MemoryStore implements ProvisioningRunStore {
  readonly steps = new Map<TenantProvisioningStep, ProvisioningStepSnapshot>(
    TENANT_PROVISIONING_STEPS.map((key) => [
      key,
      { key, status: 'PENDING' as ProvisioningExecutionStatus, attemptCount: 0 },
    ]),
  );
  runStatus: ProvisioningExecutionStatus = 'PENDING';
  retryCount = 0;

  async getSteps(): Promise<readonly ProvisioningStepSnapshot[]> {
    return TENANT_PROVISIONING_STEPS.map((key) => this.steps.get(key)!);
  }

  async transitionRun(_runId: string, status: ProvisioningExecutionStatus): Promise<void> {
    if (
      status === 'RUNNING' &&
      (this.runStatus === 'FAILED' || this.runStatus === 'EXTERNAL_BLOCKED')
    ) {
      this.retryCount += 1;
    }
    this.runStatus = status;
  }

  async transitionStep(
    _runId: string,
    step: TenantProvisioningStep,
    status: ProvisioningExecutionStatus,
    options?: {
      readonly error?: string | undefined;
      readonly metadata?: Readonly<Record<string, unknown>> | undefined;
    },
  ): Promise<void> {
    const current = this.steps.get(step)!;
    this.steps.set(step, {
      key: step,
      status,
      attemptCount: current.attemptCount + (status === 'RUNNING' ? 1 : 0),
      metadata: options?.metadata,
    });
  }
}

function plan(
  executeFor?: Partial<Record<TenantProvisioningStep, () => Promise<void>>>,
): ProvisioningOperation[] {
  return TENANT_PROVISIONING_STEPS.map((key) => ({
    key,
    execute: executeFor?.[key] ?? (async () => undefined),
    rollback: async () => undefined,
  }));
}

describe('P39 provisioning orchestrator', () => {
  it('runs the canonical provisioning plan exactly once', async () => {
    const store = new MemoryStore();
    const calls = new Map<TenantProvisioningStep, ReturnType<typeof vi.fn>>();
    const operations = TENANT_PROVISIONING_STEPS.map((key) => {
      const execute = vi.fn(async () => ({ key }));
      calls.set(key, execute);
      return { key, execute, rollback: async () => undefined };
    });

    await expect(new ProvisioningOrchestrator(store).run('run-a', operations)).resolves.toEqual({
      status: 'SUCCEEDED',
    });
    expect(store.runStatus).toBe('SUCCEEDED');
    for (const key of TENANT_PROVISIONING_STEPS) {
      expect(calls.get(key)).toHaveBeenCalledTimes(1);
      expect(store.steps.get(key)?.status).toBe('SUCCEEDED');
      expect(store.steps.get(key)?.attemptCount).toBe(1);
    }
  });

  it('is rerun-safe and skips already succeeded external work', async () => {
    const store = new MemoryStore();
    const first = vi.fn(async () => undefined);
    const operations = plan({ CREATE_TENANT: first });

    const orchestrator = new ProvisioningOrchestrator(store);
    await orchestrator.run('run-a', operations);
    await orchestrator.run('run-a', operations);

    expect(first).toHaveBeenCalledTimes(1);
    expect(store.steps.get('CREATE_TENANT')?.attemptCount).toBe(1);
  });

  it('retries only the failed checkpoint after recovery', async () => {
    const store = new MemoryStore();
    let shouldFail = true;
    const createProject = vi.fn(async () => {
      if (shouldFail) throw new Error('provider timeout');
    });
    const operations = plan({ CREATE_SUPABASE_PROJECT: createProject });
    const orchestrator = new ProvisioningOrchestrator(store);

    await expect(orchestrator.run('run-a', operations)).rejects.toThrow(/provider timeout/);
    expect(store.runStatus).toBe('FAILED');
    expect(store.steps.get('CREATE_SUPABASE_PROJECT')?.status).toBe('FAILED');

    shouldFail = false;
    await orchestrator.run('run-a', operations);

    expect(createProject).toHaveBeenCalledTimes(2);
    expect(store.retryCount).toBe(1);
    expect(store.steps.get('CREATE_TENANT')?.attemptCount).toBe(1);
    expect(store.steps.get('CREATE_SUPABASE_PROJECT')?.attemptCount).toBe(2);
    expect(store.runStatus).toBe('SUCCEEDED');
  });

  it('surfaces an external dependency without pretending the run succeeded', async () => {
    const store = new MemoryStore();
    const operations = plan({
      CREATE_SUPABASE_PROJECT: async () => {
        throw new ExternalProvisioningBlock('Supabase organization/cost approval required');
      },
    });

    await expect(new ProvisioningOrchestrator(store).run('run-a', operations)).resolves.toEqual({
      status: 'EXTERNAL_BLOCKED',
      step: 'CREATE_SUPABASE_PROJECT',
    });
    expect(store.runStatus).toBe('EXTERNAL_BLOCKED');
    expect(store.steps.get('CREATE_SUPABASE_PROJECT')?.status).toBe('EXTERNAL_BLOCKED');
    expect(store.steps.get('WAIT_UNTIL_READY')?.status).toBe('PENDING');
  });

  it('rolls back completed reversible steps in reverse order', async () => {
    const store = new MemoryStore();
    const order: string[] = [];
    const operations = TENANT_PROVISIONING_STEPS.map((key) => ({
      key,
      execute: async () => undefined,
      rollback: async () => {
        order.push(key);
      },
    }));
    const orchestrator = new ProvisioningOrchestrator(store);

    await orchestrator.run('run-a', operations);
    await orchestrator.rollback('run-a', operations);

    expect(order).toEqual([...TENANT_PROVISIONING_STEPS].reverse());
    expect(store.runStatus).toBe('ROLLED_BACK');
    for (const key of TENANT_PROVISIONING_STEPS) {
      expect(store.steps.get(key)?.status).toBe('ROLLED_BACK');
    }
  });

  it('refuses an incomplete or reordered plan', async () => {
    const store = new MemoryStore();
    const operations = plan().slice(1);
    await expect(new ProvisioningOrchestrator(store).run('run-a', operations)).rejects.toThrow(
      /canonical P39 step order/,
    );
  });
});
