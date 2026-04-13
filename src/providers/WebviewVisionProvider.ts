import * as vscode from 'vscode';
import { Logger } from '../services/Logger.js';
import { ClaudeIoPanel } from '../webview/ClaudeIoPanel.js';
import { VisionCaptureProvider, CapturedFrame, ProviderError } from './types.js';

const CAPTURE_TIMEOUT_MS = 5000;

/**
 * Webview-backed vision capture provider. Delegates getUserMedia and
 * canvas frame extraction to the webview.
 */
export class WebviewVisionProvider implements VisionCaptureProvider, vscode.Disposable {
  readonly id = 'webview';

  private readonly errorEmitter = new vscode.EventEmitter<ProviderError>();

  private messageSubscription: vscode.Disposable | undefined;
  private panelDisposedSubscription: vscode.Disposable | undefined;
  private pendingCapture:
    | { resolve: (frame: CapturedFrame) => void; reject: (err: Error) => void; timeout: NodeJS.Timeout }
    | undefined;

  constructor(
    private readonly panel: ClaudeIoPanel,
    private readonly logger: Logger,
  ) {
    this.ensureSubscribed();
    this.panelDisposedSubscription = this.panel.onPanelDisposed(() => {
      this.failPendingCapture(new Error('webview panel was disposed'));
    });
  }

  async isAvailable(): Promise<boolean> {
    await this.panel.ensurePanel();
    const caps = this.panel.getCapabilities();
    return caps?.getUserMediaAvailable ?? false;
  }

  async enable(): Promise<void> {
    await this.panel.ensurePanel();
    this.ensureSubscribed();
    this.logger.info('WebviewVisionProvider.enable');
    this.panel.setMode('camera');
    this.panel.postMessage({ type: 'camera.enable' });
  }

  async captureFrame(): Promise<CapturedFrame> {
    await this.panel.ensurePanel();
    this.ensureSubscribed();
    if (this.pendingCapture) {
      throw new Error('A capture is already in progress');
    }
    this.logger.info('WebviewVisionProvider.captureFrame');
    this.panel.setAiState('processing');
    return new Promise<CapturedFrame>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingCapture = undefined;
        reject(new Error(`Timed out waiting for camera frame (${CAPTURE_TIMEOUT_MS}ms)`));
      }, CAPTURE_TIMEOUT_MS);
      this.pendingCapture = { resolve, reject, timeout };
      this.panel.postMessage({ type: 'camera.capture' });
    });
  }

  async disable(): Promise<void> {
    this.logger.info('WebviewVisionProvider.disable');
    this.panel.postMessage({ type: 'camera.disable' });
    this.panel.setMode('idle');
    this.panel.setAiState('idle');
  }

  onError(cb: (err: ProviderError) => void): vscode.Disposable {
    return this.errorEmitter.event(cb);
  }

  dispose(): void {
    this.failPendingCapture(new Error('WebviewVisionProvider disposed'));
    this.messageSubscription?.dispose();
    this.messageSubscription = undefined;
    this.panelDisposedSubscription?.dispose();
    this.panelDisposedSubscription = undefined;
    this.errorEmitter.dispose();
  }

  private failPendingCapture(err: Error): void {
    if (!this.pendingCapture) return;
    const { reject, timeout } = this.pendingCapture;
    clearTimeout(timeout);
    this.pendingCapture = undefined;
    try {
      reject(err);
    } catch {
      // ignore — reject on an already-settled promise is a no-op
    }
  }

  private ensureSubscribed(): void {
    if (this.messageSubscription) {
      return;
    }
    this.messageSubscription = this.panel.onMessage((msg) => {
      switch (msg.type) {
        case 'camera.frame':
          if (this.pendingCapture) {
            const { resolve, timeout } = this.pendingCapture;
            clearTimeout(timeout);
            this.pendingCapture = undefined;
            resolve({
              dataUrl: msg.payload.dataUrl,
              width: msg.payload.width,
              height: msg.payload.height,
            });
            this.panel.setAiState('idle');
          }
          break;
        case 'camera.error':
          this.logger.error('WebviewVisionProvider: webview error', msg.payload);
          this.errorEmitter.fire(msg.payload);
          this.failPendingCapture(new Error(msg.payload.message));
          this.panel.setAiState('error');
          break;
        default:
          break;
      }
    });
  }
}
