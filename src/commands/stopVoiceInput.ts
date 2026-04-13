import * as vscode from 'vscode';
import { Logger } from '../services/Logger.js';
import { SessionState } from '../state/SessionState.js';
import { SttProvider } from '../providers/types.js';

export function registerStopVoiceInput(
  stt: SttProvider,
  state: SessionState,
  logger: Logger,
): vscode.Disposable {
  return vscode.commands.registerCommand('claude-io.stopVoiceInput', async () => {
    logger.info('command: claude-io.stopVoiceInput');
    if (!state.isRecording) {
      logger.warn('stopVoiceInput: not currently recording');
      return;
    }
    try {
      await stt.stop();
      state.isRecording = false;
    } catch (err) {
      logger.error('stopVoiceInput failed', err);
      void vscode.window.showErrorMessage(
        `claude-io: failed to stop voice input — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
}
