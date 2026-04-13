import * as vscode from 'vscode';
import { Logger } from '../services/Logger.js';
import { SessionState } from '../state/SessionState.js';
import { TtsProvider } from '../providers/types.js';

export function registerStopSpeaking(
  tts: TtsProvider,
  state: SessionState,
  logger: Logger,
): vscode.Disposable {
  return vscode.commands.registerCommand('claude-io.stopSpeaking', async () => {
    logger.info('command: claude-io.stopSpeaking');
    if (!state.isSpeaking) {
      return;
    }
    try {
      await tts.cancel();
      state.isSpeaking = false;
    } catch (err) {
      logger.error('stopSpeaking failed', err);
      void vscode.window.showErrorMessage(
        `claude-io: failed to stop speech — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
}
