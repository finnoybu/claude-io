import * as vscode from 'vscode';
import { Logger } from '../services/Logger.js';
import { ClaudeIoPanel } from '../webview/ClaudeIoPanel.js';
import { SessionState } from '../state/SessionState.js';
import { SttProvider, TtsProvider } from '../providers/types.js';
import { TranscriptSink } from '../services/TranscriptSink.js';

export function registerStartVoiceInput(
  panel: ClaudeIoPanel,
  stt: SttProvider,
  tts: TtsProvider,
  state: SessionState,
  sink: TranscriptSink,
  logger: Logger,
  _context: vscode.ExtensionContext,
): vscode.Disposable {
  /**
   * In continuous mode, the STT provider fires `final` for every finalized
   * phrase, which would spam the clipboard and notifications if we routed
   * each one. Instead, accumulate finals into state.currentFinal while
   * recording, then route once when recognition ends (explicit stop, error,
   * or panel disposal).
   */
  const finalSub = stt.onFinal((text) => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    state.currentFinal = state.currentFinal
      ? `${state.currentFinal} ${trimmed}`
      : trimmed;
  });

  const errSub = stt.onError((err) => {
    state.isRecording = false;
    void vscode.window
      .showErrorMessage(`claude-io STT error: ${err.message}`, 'Show Log')
      .then((selection) => {
        if (selection === 'Show Log') {
          logger.show();
        }
      });
  });

  const endedSub = stt.onEnded(async () => {
    const accumulated = state.currentFinal;
    state.currentFinal = '';
    state.isRecording = false;
    if (accumulated.trim().length === 0) {
      logger.info('stt.ended: no transcript to route');
      return;
    }
    state.lastTranscript = accumulated;
    try {
      await sink.route(accumulated);
    } catch (err) {
      logger.error('TranscriptSink.route failed', err);
      void vscode.window.showErrorMessage(
        `claude-io: failed to route transcript — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  const disposable = vscode.commands.registerCommand('claude-io.startVoiceInput', async () => {
    logger.info('command: claude-io.startVoiceInput');
    if (state.isRecording) {
      logger.warn('startVoiceInput: already recording');
      void vscode.window.showInformationMessage('claude-io: already recording.');
      return;
    }

    const config = vscode.workspace.getConfiguration('claudeIo');

    // Cancel any in-progress TTS — voice in/out are mutually exclusive.
    if (state.isSpeaking) {
      logger.info('startVoiceInput: cancelling in-progress TTS');
      await tts.cancel();
      state.isSpeaking = false;
    }

    const language = config.get<string>('stt.language', 'en-US');
    const continuous = config.get<boolean>('stt.continuous', true);

    // Reset the accumulator for this recording session.
    state.currentFinal = '';
    state.currentInterim = '';

    try {
      await panel.ensurePanel();
      const available = await stt.isAvailable();
      if (!available) {
        logger.warn('startVoiceInput: STT provider not available');
        void vscode.window
          .showErrorMessage(
            'claude-io: speech recognition is not available. ' +
              'Make sure the sidecar is running and whisper.cpp is installed ' +
              '(run `node sidecar/scripts/setup-piper.mjs`).',
            'Show Log',
          )
          .then((selection) => {
            if (selection === 'Show Log') {
              logger.show();
            }
          });
        return;
      }
      state.isRecording = true;
      await stt.start({ language, continuous });
    } catch (err) {
      state.isRecording = false;
      logger.error('startVoiceInput failed', err);
      void vscode.window.showErrorMessage(
        `claude-io: failed to start voice input — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  return vscode.Disposable.from(disposable, finalSub, errSub, endedSub);
}
