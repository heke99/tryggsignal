import { createConnection, type Socket } from 'node:net';
import { once } from 'node:events';
import type { MalwareScanner, MalwareScanResult } from './malware-scanner';

export interface ClamAvOptions {
  readonly socketPath: string;
  readonly timeoutMs?: number;
  readonly maxChunkBytes?: number;
}

interface ClamVersion {
  readonly engineVersion: string | null;
  readonly signatureVersion: string | null;
}

function responseText(chunks: readonly Buffer[]): string {
  return Buffer.concat(chunks).toString('utf8').replace(/\0+$/, '').trim();
}

function parseVersion(value: string): ClamVersion {
  const match = /ClamAV\s+([^/\s]+)\/([^/\s]+)/i.exec(value);
  return {
    engineVersion: match?.[1] ?? null,
    signatureVersion: match?.[2] ?? null,
  };
}

async function waitForDrain(socket: Socket): Promise<void> {
  if (!socket.writableNeedDrain) return;
  await once(socket, 'drain');
}

export class ClamAvScanner implements MalwareScanner {
  private readonly timeoutMs: number;
  private readonly maxChunkBytes: number;

  constructor(private readonly options: ClamAvOptions) {
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maxChunkBytes = options.maxChunkBytes ?? 1024 * 1024;
  }

  async scan(stream: AsyncIterable<Uint8Array>): Promise<MalwareScanResult> {
    const version = await this.version();
    const response = await this.streamScan(stream);

    if (response.endsWith(' OK')) {
      return {
        verdict: 'CLEAN',
        provider: 'CLAMAV',
        engineVersion: version.engineVersion,
        signatureVersion: version.signatureVersion,
        threatName: null,
      };
    }

    const found = /:\s+(.+)\s+FOUND$/.exec(response);
    if (found !== null) {
      return {
        verdict: 'INFECTED',
        provider: 'CLAMAV',
        engineVersion: version.engineVersion,
        signatureVersion: version.signatureVersion,
        threatName: found[1] ?? 'Unknown threat',
      };
    }

    throw new Error(`clamd returned an unexpected scan response: ${response}`);
  }

  private async version(): Promise<ClamVersion> {
    const response = await this.command('zVERSION\0');
    return parseVersion(response);
  }

  private command(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const socket = createConnection({ path: this.options.socketPath });
      let settled = false;

      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error !== undefined) reject(error);
        else resolve(responseText(chunks));
      };

      socket.setTimeout(this.timeoutMs, () =>
        finish(new Error(`clamd timed out after ${this.timeoutMs} ms`)),
      );
      socket.on('error', (error) => finish(error));
      socket.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        if (chunk.includes(0)) finish();
      });
      socket.on('connect', () => {
        socket.write(command);
      });
      socket.on('end', () => finish());
    });
  }

  private streamScan(stream: AsyncIterable<Uint8Array>): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const socket = createConnection({ path: this.options.socketPath });
      let settled = false;

      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error !== undefined) reject(error);
        else resolve(responseText(chunks));
      };

      socket.setTimeout(this.timeoutMs, () =>
        finish(new Error(`clamd scan timed out after ${this.timeoutMs} ms`)),
      );
      socket.on('error', (error) => finish(error));
      socket.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        if (chunk.includes(0)) finish();
      });
      socket.on('end', () => finish());

      socket.on('connect', () => {
        void (async () => {
          socket.write('zINSTREAM\0');
          await waitForDrain(socket);

          for await (const value of stream) {
            const buffer = Buffer.from(value);
            for (let offset = 0; offset < buffer.length; offset += this.maxChunkBytes) {
              const part = buffer.subarray(
                offset,
                Math.min(offset + this.maxChunkBytes, buffer.length),
              );
              const length = Buffer.allocUnsafe(4);
              length.writeUInt32BE(part.length, 0);
              socket.write(length);
              socket.write(part);
              await waitForDrain(socket);
            }
          }

          socket.write(Buffer.alloc(4));
          await waitForDrain(socket);
        })().catch((error: unknown) => {
          finish(error instanceof Error ? error : new Error(String(error)));
        });
      });
    });
  }
}
