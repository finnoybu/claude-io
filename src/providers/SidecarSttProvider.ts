import * as vscode from 'vscode';
import { Logger } from '../services/Logger.js';
import { SidecarManager, SidecarEvent } from '../sidecar/SidecarManager.js';
import { ClaudeIoPanel } from '../webview/ClaudeIoPanel.js';
import { SttProvider, SttStartOptions, ProviderError } from './types.js';

/**
 * Sidecar-backed STT provider. Sends stt.start / stt.stop / stt.cancel
 * requests to the claude-io audio sidecar, which spawns whisper-stream.exe
 * (mic capture + streaming Whisper inference in one binary).
 *
 * Replaces the webview-based WebSpeechSttProvider that was blocked by
 * VSCode's webview permission model (SpeechRecognition / getUserMedia
 * silently denied inside webviews as of the 2026-04-13 testing).
 *
 * Event mapping:
 *   - sidecar stt.ready     -> no-op (just means capture has begun)
 *   - sidecar stt.interim   -> interimEmitter
 *   - sidecar stt.error     -> errorEmitter, endedEmitter
 *   - sidecar stt.exit      -> endedEmitter (whisper-stream terminated)
 *   - sidecar shutdown      -> errorEmitter
 *
 * The accumulated final transcript is returned from the stt.stop request
 * response, not from streaming events — whisper-stream operates on a
 * sliding window and doesn't emit per-utterance final markers. We fire
 * a single finalEmitter(text) on stop() with the full accumulated text.
 */
export class SidecarSttProvider implements SttProvider, vscode.Disposable {
  readonly id = 'sidecar-whisper';

  private readonly interimEmitter = new vscode.EventEmitter<string>();
  private readonly finalEmitter = new vscode.EventEmitter<string>();
  private readonly errorEmitter = new vscode.EventEmitter<ProviderError>();
  private readonly endedEmitter = new vscode.EventEmitter<void>();

  private eventSubscription: vscode.Disposable | undefined;
  private exitSubscription: vscode.Disposable | undefined;
  private isSessionActive = false;

  constructor(
    private readonly sidecar: SidecarManager,
    private readonly panel: ClaudeIoPanel,
    private readonly logger: Logger,
  ) {
    this.eventSubscription = this.sidecar.onEvent((ev: SidecarEvent) => this.handleSidecarEvent(ev));
    this.exitSubscription = this.sidecar.onExit(() => {
      if (this.isSessionActive) {
        this.isSessionActive = false;
        this.errorEmitter.fire({
          code: 'sidecar-exited',
          message: 'sidecar process exited during STT session',
        });
        this.endedEmitter.fire();
      }
    });
  }

  async isAvailable(): Promise<boolean> {
    // Available as long as the sidecar is running. Runtime capability
    // failures (whisper binary missing, model missing, mic access denied)
    // surface as proper errors from stt.start with actionable messages.
    return true;
  }

  async start(opts: SttStartOptions): Promise<void> {
    this.logger.info(
      `SidecarSttProvider.start (language=${opts.language}, continuous=${opts.continuous})`,
    );
    this.panel.setMode('recording');
    this.panel.setAiState('listening');
    try {
      // whisper.cpp uses bare ISO 639-1 language codes (e.g. "en", "es")
      // rather than the BCP-47 tags Web Speech used (e.g. "en-US", "en-GB").
      // Strip the region suffix before handing it off.
      const language = opts.language.split('-')[0] ?? 'en';
      await this.sidecar.request('stt.start', {
        language,
        // Continuous mode is always-on for whisper-stream. The opts flag
        // is kept for interface compatibility; the setting that actually
        // matters is stepMs / lengthMs.
      });
      this.isSessionActive = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error('SidecarSttProvider.start failed', err);
      this.panel.setMode('idle');
      this.panel.setAiState('error');
      this.errorEmitter.fire({ code: 'stt-start-failed', message });
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (!this.isSessionActive) {
      this.logger.info('SidecarSttProvider.stop: no active session, ignoring');
      return;
    }
    this.logger.info('SidecarSttProvider.stop');
    try {
      const result = (await this.sidecar.request('stt.stop', undefined, 10_000)) as {
        status: string;
        text: string;
      };
      this.isSessionActive = false;
      this.panel.setMode('idle');
      this.panel.setAiState('idle');
      const text = (result.text ?? '').trim();
      if (text.length > 0) {
        this.logger.info(`SidecarSttProvider.stop: final transcript (${text.length} chars)`);
        this.finalEmitter.fire(text);
      } else {
        this.logger.warn('SidecarSttProvider.stop: empty final transcript');
      }
      this.endedEmitter.fire();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error('SidecarSttProvider.stop failed', err);
      this.isSessionActive = false;
      this.panel.setMode('idle');
      this.panel.setAiState('error');
      this.errorEmitter.fire({ code: 'stt-stop-failed', message });
      this.endedEmitter.fire();
      throw err;
    }
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
    this.eventSubscription?.dispose();
    this.eventSubscription = undefined;
    this.exitSubscription?.dispose();
    this.exitSubscription = undefined;
    this.interimEmitter.dispose();
    this.finalEmitter.dispose();
    this.errorEmitter.dispose();
    this.endedEmitter.dispose();
  }

  // ----- private -----

  private handleSidecarEvent(ev: SidecarEvent): void {
    switch (ev.method) {
      case 'stt.ready':
        // Session is now capturing. Nothing to do — the host already
        // treats the response to stt.start as the "recording started"
        // signal. We could fire an event here if the UI wants a
        // separate "mic is hot" indicator later.
        break;
      case 'stt.interim': {
        const params = ev.params as { text?: unknown } | null;
        if (params && typeof params.text === 'string') {
          this.interimEmitter.fire(params.text);
        }
        break;
      }
      case 'stt.error': {
        const params = ev.params as { code?: unknown; message?: unknown } | null;
        const code = params && typeof params.code === 'string' ? params.code : 'stt-error';
        const message =
          params && typeof params.message === 'string' ? params.message : 'unknown STT error';
        this.errorEmitter.fire({ code, message });
        if (this.isSessionActive) {
          this.isSessionActive = false;
          this.endedEmitter.fire();
        }
        break;
      }
      case 'stt.exit':
        if (this.isSessionActive) {
          this.isSessionActive = false;
          this.endedEmitter.fire();
        }
        break;
      default:
        break;
    }
  }
}
