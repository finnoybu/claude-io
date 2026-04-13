import * as vscode from 'vscode';
import { Logger } from '../services/Logger.js';
import { SessionState } from '../state/SessionState.js';
import { generateNonce } from '../util/nonce.js';
import {
  HostToWebviewMessage,
  WebviewToHostMessage,
  WebviewCapabilities,
  AiPresenceState,
  UiMode,
} from './messages.js';

const WEBVIEW_READY_TIMEOUT_MS = 5000;
const MAX_LOG_MESSAGE_LENGTH = 2048;
const MAX_STT_TEXT_LENGTH = 50_000;

/**
 * Runtime discriminated-union validator for messages coming from the webview.
 * TypeScript types are erased at runtime; this guard protects the host from
 * malformed or hostile messages. Unknown or malformed messages are dropped
 * with a warning in the log.
 */
function isValidWebviewMessage(m: unknown): m is WebviewToHostMessage {
  if (!m || typeof m !== 'object') return false;
  const obj = m as { type?: unknown; payload?: unknown };
  if (typeof obj.type !== 'string') return false;
  const p = obj.payload as Record<string, unknown> | undefined;
  switch (obj.type) {
    case 'ready':
      return (
        !!p &&
        typeof p.speechRecognitionAvailable === 'boolean' &&
        typeof p.speechSynthesisAvailable === 'boolean' &&
        typeof p.getUserMediaAvailable === 'boolean'
      );
    case 'stt.interim':
    case 'stt.final':
      return (
        !!p &&
        typeof p.text === 'string' &&
        (p.text as string).length <= MAX_STT_TEXT_LENGTH
      );
    case 'stt.error':
    case 'tts.error':
    case 'camera.error':
      return (
        !!p &&
        typeof p.code === 'string' &&
        typeof p.message === 'string' &&
        (p.message as string).length <= MAX_LOG_MESSAGE_LENGTH
      );
    case 'camera.frame':
      return (
        !!p &&
        typeof p.dataUrl === 'string' &&
        typeof p.width === 'number' &&
        typeof p.height === 'number' &&
        (p.dataUrl as string).length < 50_000_000
      );
    case 'log':
      return (
        !!p &&
        (p.level === 'info' || p.level === 'warn' || p.level === 'error') &&
        typeof p.message === 'string'
      );
    case 'stt.ended':
    case 'tts.started':
    case 'tts.ended':
    case 'camera.enabled':
    case 'camera.disabled':
      return true;
    default:
      return false;
  }
}

/**
 * Strip ASCII control chars (other than tab and newline) and truncate.
 * Used for any webview-supplied text that we log or display — prevents
 * terminal escape / bidi injection via the log channel.
 */
function sanitizeLogText(text: string): string {
  return text
    .slice(0, MAX_LOG_MESSAGE_LENGTH)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '?');
}

/**
 * Singleton webview panel for claude-io.
 *
 * Manages a single vscode.WebviewPanel that's created on first use, revealed
 * on subsequent invocations, and persists until the user closes it. Uses
 * retainContextWhenHidden so a hidden panel doesn't drop its MediaStream
 * mid-recording.
 *
 * Concurrency model:
 *   - Exactly one "ready" promise is cached in flight. Concurrent callers
 *     share the same promise and resolve together when the webview signals
 *     ready.
 *   - Messages posted before ready are buffered and flushed atomically
 *     once the ready signal arrives.
 *
 * Notifies subscribers when the panel is disposed via `onPanelDisposed` so
 * providers can abort in-flight operations and reset internal state.
 */
export class ClaudeIoPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private ready = false;
  private readyPromise: Promise<void> | undefined;
  private pendingMessages: HostToWebviewMessage[] = [];
  private capabilities: WebviewCapabilities | undefined;

  private readonly messageHandlers = new Set<(msg: WebviewToHostMessage) => void>();
  private readonly panelDisposedEmitter = new vscode.EventEmitter<void>();
  private panelDisposables: vscode.Disposable[] = [];

  readonly onPanelDisposed = this.panelDisposedEmitter.event;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly logger: Logger,
    private readonly state: SessionState,
  ) {}

  /**
   * Create the panel if it doesn't exist, otherwise reveal it.
   * Returns a promise that resolves when the webview signals `ready`.
   * Concurrent callers share a single in-flight promise.
   */
  async ensurePanel(): Promise<void> {
    if (this.ready) {
      this.panel?.reveal(vscode.ViewColumn.Beside, true);
      return;
    }
    if (this.readyPromise) {
      this.panel?.reveal(vscode.ViewColumn.Beside, true);
      return this.readyPromise;
    }

    this.logger.info('ClaudeIoPanel: creating new webview panel');

    // Create and wire the panel BEFORE exposing the ready promise, so that
    // the onDidReceiveMessage handler is attached before any message can
    // arrive from the webview side.
    const panel = vscode.window.createWebviewPanel(
      'claudeIo',
      'claude-io',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
      },
    );
    this.panel = panel;

    this.panelDisposables.push(
      panel.onDidDispose(() => this.onPanelDisposedInternal()),
      panel.webview.onDidReceiveMessage((msg: unknown) => this.handleMessage(msg)),
    );

    // Set the HTML last — this starts the webview loading, which will
    // eventually send us `ready`. We've already attached the listener.
    panel.webview.html = this.buildHtml(panel.webview);

    this.readyPromise = this.buildReadyPromise().finally(() => {
      // Clear the cached promise so future calls after ready (or after a
      // failed timeout) re-evaluate cleanly.
      this.readyPromise = undefined;
    });
    return this.readyPromise;
  }

  /**
   * Send a message to the webview. If the webview isn't ready yet, the
   * message is buffered and flushed once the `ready` signal arrives.
   */
  postMessage(message: HostToWebviewMessage): void {
    if (!this.panel) {
      this.logger.warn('ClaudeIoPanel: postMessage called before panel exists');
      this.pendingMessages.push(message);
      return;
    }
    if (!this.ready) {
      this.pendingMessages.push(message);
      return;
    }
    void this.panel.webview.postMessage(message);
  }

  setMode(mode: UiMode): void {
    this.postMessage({ type: 'ui.setMode', payload: { mode } });
  }

  setAiState(state: AiPresenceState, utterance?: string): void {
    this.postMessage({ type: 'ai.setState', payload: { state, utterance } });
  }

  onMessage(handler: (msg: WebviewToHostMessage) => void): vscode.Disposable {
    this.messageHandlers.add(handler);
    return new vscode.Disposable(() => {
      this.messageHandlers.delete(handler);
    });
  }

  async reveal(): Promise<void> {
    await this.ensurePanel();
  }

  getCapabilities(): WebviewCapabilities | undefined {
    return this.capabilities;
  }

  isPanelOpen(): boolean {
    return this.panel !== undefined;
  }

  dispose(): void {
    this.panel?.dispose();
    this.disposePanelResources();
    this.messageHandlers.clear();
    this.panelDisposedEmitter.dispose();
  }

  // ----- private -----

  private buildReadyPromise(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ready) {
        resolve();
        return;
      }
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        subscription.dispose();
        reject(
          new Error(
            `Timed out waiting for webview ready signal (${WEBVIEW_READY_TIMEOUT_MS}ms). ` +
              'The webview may have failed to load or Web Speech APIs may be unavailable. ' +
              'Try running "claude-io: Show Log" for details.',
          ),
        );
      }, WEBVIEW_READY_TIMEOUT_MS);
      const subscription = this.onMessage((msg) => {
        if (msg.type === 'ready' && !settled) {
          settled = true;
          clearTimeout(timeout);
          subscription.dispose();
          resolve();
        }
      });
    });
  }

  private onPanelDisposedInternal(): void {
    this.logger.info('ClaudeIoPanel: panel disposed');
    this.panel = undefined;
    this.ready = false;
    this.readyPromise = undefined;
    this.pendingMessages = [];
    this.capabilities = undefined;
    this.state.reset();
    this.disposePanelResources();
    this.panelDisposedEmitter.fire();
  }

  private disposePanelResources(): void {
    for (const d of this.panelDisposables) {
      try {
        d.dispose();
      } catch (err) {
        this.logger.warn('ClaudeIoPanel: error while disposing panel resource', err);
      }
    }
    this.panelDisposables = [];
  }

  private handleMessage(rawMsg: unknown): void {
    if (!isValidWebviewMessage(rawMsg)) {
      this.logger.warn(
        'ClaudeIoPanel: dropping invalid webview message',
        typeof rawMsg === 'object' && rawMsg ? (rawMsg as { type?: unknown }).type : typeof rawMsg,
      );
      return;
    }
    const msg = rawMsg;

    if (msg.type === 'ready') {
      this.logger.info('ClaudeIoPanel: webview ready', msg.payload);
      this.ready = true;
      this.capabilities = msg.payload;
      if (this.panel) {
        const toFlush = this.pendingMessages;
        this.pendingMessages = [];
        for (const buffered of toFlush) {
          void this.panel.webview.postMessage(buffered);
        }
      }
    } else if (msg.type === 'log') {
      const text = sanitizeLogText(`[webview] ${msg.payload.message}`);
      if (msg.payload.level === 'error') {
        this.logger.error(text);
      } else if (msg.payload.level === 'warn') {
        this.logger.warn(text);
      } else {
        this.logger.info(text);
      }
    }

    for (const handler of this.messageHandlers) {
      try {
        handler(msg);
      } catch (err) {
        this.logger.error('ClaudeIoPanel: message handler threw', err);
      }
    }
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = generateNonce();
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media');
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'webview.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'webview.js'));
    const cspSource = webview.cspSource;

    // Content Security Policy.
    //   default-src 'none' — deny everything, whitelist below.
    //   img-src: webview resources + blob: (camera stream) + data: (canvas exports).
    //   media-src: webview resources + blob: + mediastream: for <video> bound to getUserMedia.
    //   style-src: only webview resources + 'unsafe-inline' for <style> blocks in the
    //     webview HTML (VSCode doesn't currently provide a stable nonce path for
    //     style elements; revisit if a narrower policy becomes viable).
    //   script-src: only the nonce-tagged script we inject.
    //   connect-src https: — permits Chromium's internal Web Speech recognition
    //     cloud call. See README Privacy section for disclosure.
    const csp = [
      `default-src 'none'`,
      `img-src ${cspSource} blob: data:`,
      `media-src ${cspSource} blob: mediastream:`,
      `style-src ${cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `connect-src https:`,
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="${cssUri}">
  <title>claude-io</title>
</head>
<body>
  <header>
    <h1>claude-io</h1>
    <div id="status" class="status" role="status" aria-live="polite">Idle</div>
  </header>

  <section id="ai-presence-section" aria-label="AI presence">
    <div id="ai-presence" class="ai-presence ai-presence-idle" aria-live="polite">
      <div class="ai-ring"></div>
      <div class="ai-core"></div>
    </div>
    <pre id="ai-caption" class="caption" aria-live="polite"></pre>
  </section>

  <section id="stt-section" aria-label="Voice input">
    <h2>Voice input</h2>
    <div id="stt-indicator" class="indicator" aria-hidden="true"></div>
    <pre id="stt-interim" class="interim" aria-live="polite"></pre>
    <pre id="stt-final" class="final"></pre>
  </section>

  <section id="tts-section" aria-label="Voice output">
    <h2>Voice output</h2>
    <div id="tts-indicator" class="indicator" aria-hidden="true"></div>
    <div id="tts-current"></div>
  </section>

  <section id="camera-section" aria-label="Camera">
    <h2>Camera</h2>
    <video id="camera-preview" autoplay muted playsinline></video>
    <canvas id="camera-canvas" hidden></canvas>
    <img id="camera-thumb" alt="Last captured frame">
  </section>

  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }
}
