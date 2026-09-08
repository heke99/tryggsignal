import { PermanentJobError } from './errors';

export interface StorageDownload {
  readonly body: AsyncIterable<Uint8Array>;
  readonly contentType: string | null;
  readonly contentLength: number | null;
}

export interface StorageReader {
  download(bucket: string, path: string): Promise<StorageDownload>;
}

interface TokenResponse {
  readonly access_token?: unknown;
  readonly expires_in?: unknown;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new PermanentJobError(`${name} is required for document processing`);
  }
  return value;
}

function encodedObjectPath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

async function* streamBody(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value !== undefined) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

export class SupabaseServiceAccountStorageReader implements StorageReader {
  private accessToken: string | null = null;
  private expiresAt = 0;

  constructor(
    private readonly config: {
      readonly url: string;
      readonly publishableKey: string;
      readonly email: string;
      readonly password: string;
    },
  ) {}

  async download(bucket: string, path: string): Promise<StorageDownload> {
    const token = await this.token();
    const response = await fetch(
      `${this.config.url.replace(/\/$/, '')}/storage/v1/object/authenticated/${encodeURIComponent(bucket)}/${encodedObjectPath(path)}`,
      {
        method: 'GET',
        headers: {
          apikey: this.config.publishableKey,
          Authorization: `Bearer ${token}`,
          'Cache-Control': 'no-store',
        },
        cache: 'no-store',
      },
    );

    if (!response.ok || response.body === null) {
      throw new Error(`Storage download failed with HTTP ${response.status}`);
    }

    const lengthHeader = response.headers.get('content-length');
    const parsedLength = lengthHeader === null ? null : Number(lengthHeader);

    return {
      body: streamBody(response.body),
      contentType: response.headers.get('content-type'),
      contentLength: Number.isFinite(parsedLength) ? parsedLength : null,
    };
  }

  private async token(): Promise<string> {
    if (this.accessToken !== null && Date.now() < this.expiresAt - 60_000) {
      return this.accessToken;
    }

    const response = await fetch(
      `${this.config.url.replace(/\/$/, '')}/auth/v1/token?grant_type=password`,
      {
        method: 'POST',
        headers: {
          apikey: this.config.publishableKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: this.config.email,
          password: this.config.password,
        }),
        cache: 'no-store',
      },
    );

    if (!response.ok) {
      throw new PermanentJobError(
        `Worker Storage service account authentication failed with HTTP ${response.status}`,
      );
    }

    const payload = (await response.json()) as TokenResponse;
    if (typeof payload.access_token !== 'string' || payload.access_token.length === 0) {
      throw new PermanentJobError('Worker Storage authentication returned no access token');
    }

    const expiresIn =
      typeof payload.expires_in === 'number' && Number.isFinite(payload.expires_in)
        ? payload.expires_in
        : 3600;

    this.accessToken = payload.access_token;
    this.expiresAt = Date.now() + expiresIn * 1000;
    return this.accessToken;
  }
}

export function storageReaderFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): StorageReader {
  return new SupabaseServiceAccountStorageReader({
    url: required(env, 'WORKER_SUPABASE_URL'),
    publishableKey: required(env, 'WORKER_SUPABASE_PUBLISHABLE_KEY'),
    email: required(env, 'WORKER_STORAGE_EMAIL'),
    password: required(env, 'WORKER_STORAGE_PASSWORD'),
  });
}
