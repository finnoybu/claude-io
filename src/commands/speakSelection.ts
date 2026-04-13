import * as vscode from 'vscode';
import { Logger } from '../services/Logger.js';
import { SessionState } from '../state/SessionState.js';
import { SttProvider, TtsProvider } from '../providers/types.js';

export function registerSpeakSelection(
  tts: TtsProvider,
  stt: SttProvider,
  state: SessionState,
  logger: Logger,
): vscode.Disposable {
  const startSub = tts.onStart(() => {
    state.isSpeaking = true;
  });
  const endSub = tts.onEnd(() => {
    state.isSpeaking = false;
  });
  const errSub = tts.onError((err) => {
    state.isSpeaking = false;
    void vscode.window
      .showErrorMessage(`claude-io TTS error: ${err.message}`, 'Show Log')
      .then((selection) => {
        if (selection === 'Show Log') {
          logger.show();
        }
      });
  });

  const disposable = vscode.commands.registerCommand('claude-io.speakSelection', async () => {
    logger.info('command: claude-io.speakSelection');
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showWarningMessage('claude-io: no active editor.');
      return;
    }

    if (editor.selection.isEmpty) {
      void vscode.window.showWarningMessage(
        'claude-io: no text selected. Select the text you want spoken first.',
      );
      return;
    }
    const text = editor.document.getText(editor.selection);
    if (text.trim().length === 0) {
      void vscode.window.showWarningMessage('claude-io: selection is empty.');
      return;
    }

    // STT and TTS are mutually exclusive — cancel any in-progress recording.
    if (state.isRecording) {
      logger.info('speakSelection: cancelling in-progress STT');
      await stt.stop();
      state.isRecording = false;
    }

    try {
      const available = await tts.isAvailable();
      if (!available) {
        logger.warn('speakSelection: TTS provider not available');
        void vscode.window.showErrorMessage(
          'claude-io: speech synthesis is not available in this environment.',
        );
        return;
      }
      const config = vscode.workspace.getConfiguration('claudeIo');
      const voice = config.get<string>('tts.voice', '') || undefined;
      const rate = config.get<number>('tts.rate', 1.0);
      const pitch = config.get<number>('tts.pitch', 1.0);
      await tts.speak(text, { voice, rate, pitch });
    } catch (err) {
      logger.error('speakSelection failed', err);
      void vscode.window.showErrorMessage(
        `claude-io: failed to speak — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  return vscode.Disposable.from(disposable, startSub, endSub, errSub);
}
