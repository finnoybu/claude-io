import * as vscode from 'vscode';
import * as path from 'node:path';
import { ChildProcess, spawn } from 'node:child_process';
import { Logger } from '../services/Logger.js';

/**
 * Manages the claude-io audio sidecar process.
 *
 * The sidecar is a separate Node process, spawned as a child of the
 * extension host. It owns the microphone and speaker, runs whisper.cpp
 * and Piper for STT/TTS, and communicates with this class via JSON-RPC
 * over stdin/stdout (one JSON object per line).
 *
 * Protocol:
 *   - Requests (extension -> sidecar): { id, method, params? }
 *   - Responses (sidecar -> extension): { id, result? | error? }
 *   - Events (sidecar -> extension): { method, params? }  (no id)
 *
 * Use `request(method, params)` to send a request and await its response.
 * Use `onEvent` to subscribe to unsolicited events from the sidecar.
 */
export interface SidecarEvent {
  method: string;
  params: unknown;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export class SidecarManager implements vscode.Disposable {
  private process: ChildProcess | undefined;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly eventEmitter = new vscode.EventEmitter<SidecarEvent>();
  private readonly exitEmitter = new vscode.EventEmitter<{ code: number | null; signal: NodeJS.Signals | null }>();

  readonly onEvent = this.eventEmitter.event;
  readonly onExit = this.exitEmitter.event;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly logger: Logger,
  ) {}

  /**
   * Spawn the sidecar process. Idempotent — if already running, does nothing.
   */
  async start(): Promise<void> {
    if (this.process) {
      return;
    }
    const sidecarMain = path.join(this.extensionUri.fsPath, 'sidecar', 'dist', 'main.js');
    this.logger.info(`SidecarManager: spawning node ${sidecarMain}`);

    const child = spawn(process.execPath, [sidecarMain], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      windowsHide: true,
    });

    this.process = child;

    child.stdout!.on('data', (chunk: Buffer) => this.onStdout(chunk));
    child.stderr!.on('data', (chunk: Buffer) => {
      // stderr is reserved for fatal paths in the sidecar; surface it at error level.
      const text = chunk.toString('utf8').trim();
      if (text.length > 0) {
        this.logger.error(`[sidecar.stderr] ${text}`);
      }
    });
    child.on('error', (err) => {
      this.logger.error('SidecarManager: child process error', err);
    });
    child.on('exit', (code, signal) => {
      this.logger.warn(`SidecarManager: sidecar exited code=${code} signal=${signal ?? 'null'}`);
      const previous = this.process;
      this.process = undefined;
      // Fail any in-flight requests.
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(`sidecar exited before request ${id} completed`));
      }
      this.pending.clear();
      this.buffer = '';
      if (previous === child) {
        this.exitEmitter.fire({ code, signal });
      }
    });
  }

  /**
   * Send a JSON-RPC request to the sidecar and await its response.
   */
  request(method: string, params?: unknown, timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS): Promise<unknown> {
    const child = this.process;
    const stdin = child?.stdin;
    if (!child || !stdin || stdin.destroyed) {
      return Promise.reject(new Error('sidecar is not running'));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`sidecar request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      const line = JSON.stringify({ id, method, params }) + '\n';
      try {
        stdin.write(line);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timeout);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Ask the sidecar to shut down gracefully. Falls back to SIGTERM if the
   * shutdown request fails or times out.
   */
  async stop(): Promise<void> {
    const child = this.process;
    if (!child) return;
    try {
      await this.request('shutdown', undefined, 2000);
      // Give it a brief moment to actually exit on its own.
      await new Promise((resolve) => setTimeout(resolve, 200));
    } catch (err) {
      this.logger.warn('SidecarManager: graceful shutdown failed, sending SIGTERM', err);
    }
    if (this.process) {
      try {
        this.process.kill('SIGTERM');
      } catch (err) {
        this.logger.warn('SidecarManager: SIGTERM failed', err);
      }
    }
  }

  dispose(): void {
    void this.stop();
    this.eventEmitter.dispose();
    this.exitEmitter.dispose();
  }

  // ----- private -----

  private onStdout(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.length === 0) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      this.logger.error(`SidecarManager: invalid JSON on sidecar stdout: ${line.slice(0, 200)}`, err);
      return;
    }
    if (!msg || typeof msg !== 'object') {
      this.logger.warn('SidecarManager: sidecar stdout message is not an object');
      return;
    }
    const obj = msg as {
      id?: unknown;
      method?: unknown;
      result?: unknown;
      error?: unknown;
      params?: unknown;
    };

    if (typeof obj.id === 'number') {
      const pending = this.pending.get(obj.id);
      if (!pending) {
        this.logger.warn(`SidecarManager: response for unknown id ${obj.id}`);
        return;
      }
      this.pending.delete(obj.id);
      clearTimeout(pending.timeout);
      if (obj.error && typeof obj.error === 'object') {
        const err = obj.error as { code?: string; message?: string };
        pending.reject(new Error(err.message ?? 'sidecar returned error'));
      } else {
        pending.resolve(obj.result);
      }
      return;
    }

    if (typeof obj.method === 'string') {
      if (obj.method === 'log') {
        const params = obj.params as { level?: string; message?: string } | undefined;
        if (params?.message) {
          const text = `[sidecar] ${params.message}`;
          if (params.level === 'error') {
            this.logger.error(text);
          } else if (params.level === 'warn') {
            this.logger.warn(text);
          } else {
            this.logger.info(text);
          }
        }
      }
      this.eventEmitter.fire({ method: obj.method, params: obj.params });
      return;
    }

    this.logger.warn('SidecarManager: sidecar stdout message has neither id nor method');
  }
}
