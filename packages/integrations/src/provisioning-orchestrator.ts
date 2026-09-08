export const TENANT_PROVISIONING_STEPS = [
  'CREATE_TENANT',
  'RESERVE_SLUG',
  'CREATE_TENANT_DEPLOYMENT',
  'CREATE_SUPABASE_PROJECT',
  'WAIT_UNTIL_READY',
  'APPLY_BASE_MIGRATIONS',
  'ENABLE_REQUIRED_EXTENSIONS',
  'APPLY_AUTHORIZATION',
  'SEED_SYSTEM_ROLES',
  'CREATE_BRANDING_DRAFT',
  'ENABLE_PLATFORM_DOMAIN',
  'CONFIGURE_AUTH',
  'RUN_HEALTH_CHECK',
  'RUN_SECURITY_SMOKE',
  'RUN_TENANT_ISOLATION',
  'MARK_CUSTOMER_TEST_READY',
  'PROMOTE',
] as const;

export type TenantProvisioningStep = (typeof TENANT_PROVISIONING_STEPS)[number];

export type ProvisioningExecutionStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'EXTERNAL_BLOCKED'
  | 'ROLLED_BACK';

export interface ProvisioningStepSnapshot {
  readonly key: TenantProvisioningStep;
  readonly status: ProvisioningExecutionStatus;
  readonly attemptCount: number;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

export interface ProvisioningRunStore {
  getSteps(runId: string): Promise<readonly ProvisioningStepSnapshot[]>;
  transitionRun(
    runId: string,
    status: ProvisioningExecutionStatus,
    error?: string | undefined,
  ): Promise<void>;
  transitionStep(
    runId: string,
    step: TenantProvisioningStep,
    status: ProvisioningExecutionStatus,
    options?: {
      readonly error?: string | undefined;
      readonly metadata?: Readonly<Record<string, unknown>> | undefined;
    },
  ): Promise<void>;
}

export interface ProvisioningOperation {
  readonly key: TenantProvisioningStep;
  execute(): Promise<Readonly<Record<string, unknown>> | void>;
  /**
   * Rollback is deliberately explicit. Infrastructure that cannot be safely
   * deleted must provide a compensating action (for example disable/pause) or
   * omit rollback and be handled by the runbook.
   */
  rollback?(): Promise<void>;
}

export class ExternalProvisioningBlock extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExternalProvisioningBlock';
  }
}

export class ProvisioningOrchestrator {
  constructor(private readonly store: ProvisioningRunStore) {}

  async run(
    runId: string,
    operations: readonly ProvisioningOperation[],
  ): Promise<{
    readonly status: 'SUCCEEDED' | 'EXTERNAL_BLOCKED';
    readonly step?: TenantProvisioningStep;
  }> {
    this.assertPlan(operations);
    await this.store.transitionRun(runId, 'RUNNING');

    const snapshots = new Map(
      (await this.store.getSteps(runId)).map((snapshot) => [snapshot.key, snapshot] as const),
    );

    for (const operation of operations) {
      const existing = snapshots.get(operation.key);
      if (existing?.status === 'SUCCEEDED') continue;

      await this.store.transitionStep(runId, operation.key, 'RUNNING');
      try {
        const metadata = await operation.execute();
        await this.store.transitionStep(runId, operation.key, 'SUCCEEDED', {
          ...(metadata === undefined ? {} : { metadata }),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown provisioning failure';
        if (error instanceof ExternalProvisioningBlock) {
          await this.store.transitionStep(runId, operation.key, 'EXTERNAL_BLOCKED', {
            error: message,
          });
          await this.store.transitionRun(runId, 'EXTERNAL_BLOCKED', message);
          return { status: 'EXTERNAL_BLOCKED', step: operation.key };
        }

        await this.store.transitionStep(runId, operation.key, 'FAILED', { error: message });
        await this.store.transitionRun(runId, 'FAILED', message);
        throw error;
      }
    }

    await this.store.transitionRun(runId, 'SUCCEEDED');
    return { status: 'SUCCEEDED' };
  }

  async rollback(runId: string, operations: readonly ProvisioningOperation[]): Promise<void> {
    this.assertPlan(operations);
    const snapshots = new Map(
      (await this.store.getSteps(runId)).map((snapshot) => [snapshot.key, snapshot] as const),
    );

    for (const operation of [...operations].reverse()) {
      if (snapshots.get(operation.key)?.status !== 'SUCCEEDED') continue;
      if (operation.rollback === undefined) continue;

      await operation.rollback();
      await this.store.transitionStep(runId, operation.key, 'ROLLED_BACK');
    }

    await this.store.transitionRun(runId, 'ROLLED_BACK');
  }

  private assertPlan(operations: readonly ProvisioningOperation[]): void {
    const keys = operations.map((operation) => operation.key);
    const expected = TENANT_PROVISIONING_STEPS;
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
      throw new Error('Provisioning operations must follow the canonical P39 step order.');
    }
  }
}
