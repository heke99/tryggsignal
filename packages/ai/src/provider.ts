/**
 * Masterplan 75/76: provider-neutral AI. The application depends on this
 * interface, never on a vendor SDK, and every run is auditable.
 */

export const AI_TASKS = [
  'document_classification',
  'metadata_extraction',
  'case_summary',
  'completeness_assistance',
  'referral_summary',
  'document_version_comparison',
  'work_queue_triage',
  'draft_generation',
  'plan_context_analysis',
  'anomaly_detection',
] as const;

export type AiTask = (typeof AI_TASKS)[number];

export interface PromptVersion {
  readonly taskKey: AiTask;
  readonly version: number;
  readonly systemPrompt: string;
  readonly prompt: string;
}

export interface AiRequest {
  readonly task: AiTask;
  readonly promptVersion: PromptVersion;
  /** Document text and other untrusted content, kept separate from instructions. */
  readonly untrustedContent: readonly { readonly label: string; readonly text: string }[];
  readonly authorityId: string;
  readonly caseId: string | null;
  readonly correlationId: string;
}

export interface AiFinding {
  readonly findingType: string;
  readonly finding: string;
  readonly extractedValue: string | null;
  readonly confidence: number | null;
  readonly sourceDocumentVersionId: string | null;
  readonly sourcePage: number | null;
  readonly sourceSection: string | null;
}

export interface AiResponse {
  readonly findings: readonly AiFinding[];
  readonly tokenUsage: Readonly<Record<string, number>>;
  readonly latencyMs: number;
  readonly modelKey: string;
}

export interface AiProvider {
  readonly key: string;
  complete(request: AiRequest): Promise<AiResponse>;
  healthCheck(): Promise<{ readonly healthy: boolean; readonly detail: string }>;
}

export class AiProviderNotConfiguredError extends Error {
  constructor(task: AiTask) {
    super(
      `No AI provider is configured for task "${task}". ` +
        'Configure a provider and its data-processing agreement before enabling AI features.',
    );
    this.name = 'AiProviderNotConfiguredError';
  }
}

/** Used until a provider decision and its data-processing terms exist. */
export class UnconfiguredAiProvider implements AiProvider {
  readonly key = 'unconfigured';

  async complete(request: AiRequest): Promise<AiResponse> {
    throw new AiProviderNotConfiguredError(request.task);
  }

  async healthCheck(): Promise<{ healthy: boolean; detail: string }> {
    return { healthy: false, detail: 'EXTERNAL_BLOCKED: no AI provider configured' };
  }
}
