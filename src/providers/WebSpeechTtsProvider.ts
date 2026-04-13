import * as vscode from 'vscode';
import { Logger } from '../services/Logger.js';
import { ClaudeIoPanel } from '../webview/ClaudeIoPanel.js';
import { TtsProvider, TtsSpeakOptions, ProviderError } from './types.js';

/**
 * Web Speech API TTS provider. Delegates speechSynthesis to the webview.
 * TTS runs entirely locally via the OS; no network traffic. This is why
 * we don't gate it behind the allowNetworkSpeechRecognition setting.
 */
export class WebSpeechTtsProvider implements TtsProvider, vscode.Disposable {
  readonly id = 'web-speech';

  private readonly startEmitter = new vscode.EventEmitter<void>();
  private readonly endEmitter = new vscode.EventEmitter<void>();
  private readonly errorEmitter = new vscode.EventEmitter<ProviderError>();

  private messageSubscription: vscode.Disposable | undefined;
  private panelDisposedSubscription: vscode.Disposable | undefined;

  constructor(
    private readonly panel: ClaudeIoPanel,
    private readonly logger: Logger,
  ) {
    this.ensureSubscribed();
    this.panelDisposedSubscription = this.panel.onPanelDisposed(() => {
      // If the panel is closed mid-speech, speechSynthesis stops with it.
      // Fire end so state is cleared upstream.
      this.endEmitter.fire();
    });
  }

  async isAvailable(): Promise<boolean> {
    await this.panel.ensurePanel();
    const caps = this.panel.getCapabilities();
    return caps?.speechSynthesisAvailable ?? false;
  }

  async speak(text: string, opts?: TtsSpeakOptions): Promise<void> {
    await this.panel.ensurePanel();
    this.ensureSubscribed();
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      this.logger.warn('WebSpeechTtsProvider.speak: empty text');
      return;
    }
    this.logger.info(`WebSpeechTtsProvider.speak (${trimmed.length} chars)`);
    this.panel.setMode('speaking');
    this.panel.setAiState('speaking', trimmed);
    this.panel.postMessage({
      type: 'tts.speak',
      payload: {
        text: trimmed,
        voice: opts?.voice,
        rate: opts?.rate,
        pitch: opts?.pitch,
      },
    });
  }

  async cancel(): Promise<void> {
    this.logger.info('WebSpeechTtsProvider.cancel');
    this.panel.postMessage({ type: 'tts.cancel' });
    this.panel.setMode('idle');
    this.panel.setAiState('idle');
  }

  onStart(cb: () => void): vscode.Disposable {
    return this.startEmitter.event(cb);
  }

  onEnd(cb: () => void): vscode.Disposable {
    return this.endEmitter.event(cb);
  }

  onError(cb: (err: ProviderError) => void): vscode.Disposable {
    return this.errorEmitter.event(cb);
  }

  dispose(): void {
    this.messageSubscription?.dispose();
    this.messageSubscription = undefined;
    this.panelDisposedSubscription?.dispose();
    this.panelDisposedSubscription = undefined;
    this.startEmitter.dispose();
    this.endEmitter.dispose();
    this.errorEmitter.dispose();
  }

  private ensureSubscribed(): void {
    if (this.messageSubscription) {
      return;
    }
    this.messageSubscription = this.panel.onMessage((msg) => {
      switch (msg.type) {
        case 'tts.started':
          this.startEmitter.fire();
          break;
        case 'tts.ended':
          this.endEmitter.fire();
          this.panel.setAiState('idle');
          break;
        case 'tts.error':
          this.logger.error('WebSpeechTtsProvider: webview error', msg.payload);
          this.errorEmitter.fire(msg.payload);
          this.panel.setAiState('error');
          break;
        default:
          break;
      }
    });
  }
}
