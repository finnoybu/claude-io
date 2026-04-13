/**
 * JSON-RPC over stdin/stdout for the claude-io sidecar.
 *
 * Protocol:
 *   - One JSON object per line on stdin (from extension host)
 *   - One JSON object per line on stdout (responses + events to extension)
 *   - All diagnostic output goes over the RPC channel via `log` events
 *     so the extension can surface it in the output channel. stderr is
 *     reserved for uncaught-exception paths where RPC might not work.
 *
 * Message shapes:
 *   Request:  { id: number, method: string, params?: unknown }
 *   Response: { id: number, result: unknown } | { id: number, error: { code, message } }
 *   Event:    { method: string, params?: unknown }     (no id)
 */

export interface RpcRequest {
  id: number;
  method: string;
  params?: unknown;
}

export interface RpcResponseOk {
  id: number;
  result: unknown;
}

export interface RpcResponseErr {
  id: number;
  error: { code: string; message: string };
}

export type RpcResponse = RpcResponseOk | RpcResponseErr;

export interface RpcEvent {
  method: string;
  params?: unknown;
}

export type RpcOutgoing = RpcResponse | RpcEvent;

export type RequestHandler = (params: unknown) => Promise<unknown>;

export type LogLevel = 'info' | 'warn' | 'error';

export class RpcServer {
  private readonly handlers = new Map<string, RequestHandler>();
  private buffer = '';
  private readonly inFlight = new Set<Promise<void>>();
  private draining = false;

  constructor() {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string | Buffer) => {
      this.onStdinData(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });
    process.stdin.on('end', () => {
      void this.drainAndExit('stdin closed');
    });
  }

  /**
   * Wait for all in-flight requests to complete, then exit. Called when
   * stdin closes (parent hung up) or on explicit shutdown. Idempotent.
   */
  private async drainAndExit(reason: string): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    const pendingCount = this.inFlight.size;
    this.log('info', `sidecar: ${reason}, draining ${pendingCount} in-flight request(s)`);
    // Wait for every in-flight handler to settle before exiting.
    // Promise.allSettled ensures a rejection in one handler doesn't
    // short-circuit the drain for others.
    if (pendingCount > 0) {
      await Promise.allSettled(Array.from(this.inFlight));
    }
    this.log('info', 'sidecar: drain complete, exiting');
    // Give the final log line time to flush to stdout before we exit.
    setTimeout(() => process.exit(0), 50);
  }

  register(method: string, handler: RequestHandler): void {
    this.handlers.set(method, handler);
  }

  event(method: string, params?: unknown): void {
    this.send({ method, params });
  }

  log(level: LogLevel, message: string): void {
    this.event('log', { level, message });
  }

  private onStdinData(chunk: string): void {
    this.buffer += chunk;
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.length === 0) continue;
      void this.handleLine(line);
    }
  }

  private async handleLine(line: string): Promise<void> {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      this.log('error', `sidecar: invalid JSON on stdin: ${String(err)}`);
      return;
    }
    if (!msg || typeof msg !== 'object') {
      this.log('error', 'sidecar: stdin message is not an object');
      return;
    }
    const obj = msg as { id?: unknown; method?: unknown };
    if (typeof obj.method !== 'string') {
      this.log('error', 'sidecar: stdin message has no method');
      return;
    }
    if (typeof obj.id === 'number') {
      await this.handleRequest(msg as RpcRequest);
    } else {
      // Extension shouldn't send events to us, only requests. Log and drop.
      this.log('warn', `sidecar: received event from parent, ignoring: ${obj.method}`);
    }
  }

  private async handleRequest(req: RpcRequest): Promise<void> {
    const handler = this.handlers.get(req.method);
    if (!handler) {
      this.send({
        id: req.id,
        error: { code: 'method-not-found', message: `unknown method: ${req.method}` },
      });
      return;
    }
    // Track the handler's promise so drainAndExit can wait for it on
    // stdin-close. We wrap handler invocation in an inner async function
    // so we have a single promise to add to the set.
    const promise = (async () => {
      try {
        const result = await handler(req.params);
        this.send({ id: req.id, result });
      } catch (err) {
        this.send({
          id: req.id,
          error: {
            code: 'handler-error',
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
    })();
    this.inFlight.add(promise);
    promise.finally(() => this.inFlight.delete(promise));
    await promise;
  }

  private send(msg: RpcOutgoing): void {
    process.stdout.write(JSON.stringify(msg) + '\n');
  }
}
