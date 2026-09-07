/** Masterplan 86: correlation across app, database, queues, integrations and AI. */
import { randomUUID } from 'node:crypto';

export interface RequestContext {
  readonly traceId: string;
  readonly correlationId: string;
  readonly requestId: string;
  readonly tenantId: string | null;
  readonly authorityId: string | null;
  readonly userId: string | null;
}

export function createRequestContext(partial: Partial<RequestContext> = {}): RequestContext {
  const correlationId = partial.correlationId ?? randomUUID();
  return {
    traceId: partial.traceId ?? correlationId,
    correlationId,
    requestId: partial.requestId ?? randomUUID(),
    tenantId: partial.tenantId ?? null,
    authorityId: partial.authorityId ?? null,
    userId: partial.userId ?? null,
  };
}

const REDACTED = '[redacted]';
const SENSITIVE_KEY = /(token|secret|password|key|authorization|cookie|personnummer|ssn)/i;

/** Masterplan 64/85: credentials and personal identifiers never reach the log sink. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1));
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(entry, depth + 1);
  }
  return output;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogRecord {
  readonly level: LogLevel;
  readonly message: string;
  readonly timestamp: string;
  readonly context: RequestContext;
  readonly data: unknown;
}

export type LogSink = (record: LogRecord) => void;

export const consoleSink: LogSink = (record) => {
  // Structured single-line JSON so the platform log drain can parse it.
  const line = JSON.stringify(record);
  if (record.level === 'error' || record.level === 'warn') console.error(line);
  else console.warn(line);
};

export function createLogger(context: RequestContext, sink: LogSink = consoleSink) {
  const emit = (level: LogLevel) => (message: string, data?: unknown) =>
    sink({
      level,
      message,
      timestamp: new Date().toISOString(),
      context,
      data: redact(data),
    });
  return {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    context,
  };
}
