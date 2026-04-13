import * as vscode from 'vscode';
import { Logger } from '../services/Logger.js';
import { ClaudeIoPanel } from '../webview/ClaudeIoPanel.js';
import { SttProvider, SttStartOptions, ProviderError } from './types.js';

/**
 * Web Speech API STT provider. Delegates the actual recognition work to
 * the webview (which is Chromium and has access to SpeechRecognition /
 * webkitSpeechRecognition). This class is a host-side facade that
 * translates interface method calls into postMessage calls and exposes
 * event-emitter callbacks for the results.
 */
export class WebSpeechSttProvider implements SttProvider, vscode.Disposable {
  readonly id = 'web-speech';

  private readonly interimEmitter = new vscode.EventEmitter<string>();
  private readonly finalEmitter = new vscode.EventEmitter<string>();
  private readonly errorEmitter = new vscode.EventEmitter<ProviderError>();
  private readonly endedEmitter = new vscode.EventEmitter<void>();

  private messageSubscription: vscode.Disposable | undefined;
  private panelDisposedSubscription: vscode.Disposable | undefined;

  constructor(
    private readonly panel: ClaudeIoPanel,
    private readonly logger: Logger,
  ) {
    this.ensureSubscribed();
    this.panelDisposedSubscription = this.panel.onPanelDisposed(() => {
      // If the user closes the panel mid-recording, the webview is gone
      // and recognition cannot deliver any more events. Signal an end so
      // state is cleared upstream.
      this.endedEmitter.fire();
    });
  }

  async isAvailable(): Promise<boolean> {
    await this.panel.ensurePanel();
    const caps = this.panel.getCapabilities();
    return caps?.speechRecognitionAvailable ?? false;
  }

  async start(opts: SttStartOptions): Promise<void> {
    await this.panel.ensurePanel();
    this.ensureSubscribed();
    this.logger.info(
      `WebSpeechSttProvider.start (lang=${opts.language}, continuous=${opts.continuous})`,
    );
    this.panel.setMode('recording');
    this.panel.setAiState('listening');
    this.panel.postMessage({
      type: 'stt.start',
      payload: { language: opts.language, continuous: opts.continuous },
    });
  }

  async stop(): Promise<void> {
    this.logger.info('WebSpeechSttProvider.stop');
    this.panel.postMessage({ type: 'stt.stop' });
    this.panel.setMode('idle');
    this.panel.setAiState('idle');
  }

  onInterim(cb: (text: string) => void): vscode.Disposable {
    return this.interimEmitter.event(cb);
  }

  onFinal(cb: (text: string) => void): vscode.Disposable {
    return this.finalEmitter.event(cb);
  }

  onError(cb: (err: ProviderError) => void): vscode.Disposable {
    return this.errorEmitter.event(cb);
  }

  onEnded(cb: () => void): vscode.Disposable {
    return this.endedEmitter.event(cb);
  }

  dispose(): void {
    this.messageSubscription?.dispose();
    this.messageSubscription = undefined;
    this.panelDisposedSubscription?.dispose();
    this.panelDisposedSubscription = undefined;
    this.interimEmitter.dispose();
    this.finalEmitter.dispose();
    this.errorEmitter.dispose();
    this.endedEmitter.dispose();
  }

  private ensureSubscribed(): void {
    if (this.messageSubscription) {
      return;
    }
    this.messageSubscription = this.panel.onMessage((msg) => {
      switch (msg.type) {
        case 'stt.interim':
          this.interimEmitter.fire(msg.payload.text);
          break;
        case 'stt.final':
          this.finalEmitter.fire(msg.payload.text);
          break;
        case 'stt.error':
          this.logger.error('WebSpeechSttProvider: webview error', msg.payload);
          this.errorEmitter.fire(msg.payload);
          this.panel.setAiState('error');
          // Also signal end so any accumulators can flush.
          this.endedEmitter.fire();
          break;
        case 'stt.ended':
          this.endedEmitter.fire();
          break;
        default:
          break;
      }
    });
  }
}
