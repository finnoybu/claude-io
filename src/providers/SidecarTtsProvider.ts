import * as vscode from 'vscode';
import { Logger } from '../services/Logger.js';
import { SidecarManager, SidecarEvent } from '../sidecar/SidecarManager.js';
import { TtsProvider, TtsSpeakOptions, ProviderError } from './types.js';

/**
 * Sidecar-backed TTS provider. Sends `tts.speak` requests to the
 * claude-io audio sidecar, which spawns Piper, generates WAV, and plays
 * it via platform-native audio tools.
 *
 * This replaces the webview-based WebSpeechTtsProvider that used
 * browser speechSynthesis (SAPI on Windows — the "bad robot" voice).
 * Quality is markedly better because Piper runs a real neural TTS
 * model instead of relying on the OS defaults.
 */
export class SidecarTtsProvider implements TtsProvider, vscode.Disposable {
  readonly id = 'sidecar-piper';

  private readonly startEmitter = new vscode.EventEmitter<void>();
  private readonly endEmitter = new vscode.EventEmitter<void>();
  private readonly errorEmitter = new vscode.EventEmitter<ProviderError>();

  private eventSubscription: vscode.Disposable | undefined;
  private exitSubscription: vscode.Disposable | undefined;

  constructor(
    private readonly sidecar: SidecarManager,
    private readonly logger: Logger,
  ) {
    this.eventSubscription = this.sidecar.onEvent((ev: SidecarEvent) => {
      switch (ev.method) {
        case 'tts.started':
          this.startEmitter.fire();
          break;
        case 'tts.ended':
          this.endEmitter.fire();
          break;
        default:
          break;
      }
    });
    this.exitSubscription = this.sidecar.onExit(() => {
      this.errorEmitter.fire({
        code: 'sidecar-exited',
        message: 'sidecar process exited during TTS operation',
      });
    });
  }

  async isAvailable(): Promise<boolean> {
    // The sidecar is always "available" — any runtime capability check
    // (e.g., missing piper binary) surfaces as a proper error from
    // tts.speak itself with a useful message pointing at setup-piper.mjs.
    return true;
  }

  async speak(text: string, opts?: TtsSpeakOptions): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      this.logger.warn('SidecarTtsProvider.speak: empty text');
      return;
    }
    this.logger.info(`SidecarTtsProvider.speak (${trimmed.length} chars, voice=${opts?.voice ?? 'default'})`);
    try {
      await this.sidecar.request(
        'tts.speak',
        {
          text: trimmed,
          voice: opts?.voice,
        },
        // Generous timeout — Piper needs time to synthesize, plus full
        // playback time before the response arrives.
        5 * 60_000,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error('SidecarTtsProvider.speak failed', err);
      this.errorEmitter.fire({ code: 'tts-failed', message });
      throw err;
    }
  }

  async cancel(): Promise<void> {
    this.logger.info('SidecarTtsProvider.cancel');
    try {
      await this.sidecar.request('tts.cancel', undefined, 2000);
    } catch (err) {
      this.logger.warn('SidecarTtsProvider.cancel failed', err);
    }
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
    this.eventSubscription?.dispose();
    this.eventSubscription = undefined;
    this.exitSubscription?.dispose();
    this.exitSubscription = undefined;
    this.startEmitter.dispose();
    this.endEmitter.dispose();
    this.errorEmitter.dispose();
  }
}
