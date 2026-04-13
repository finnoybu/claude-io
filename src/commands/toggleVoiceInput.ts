import * as vscode from 'vscode';
import { Logger } from '../services/Logger.js';
import { ClaudeIoPanel } from '../webview/ClaudeIoPanel.js';
import { SessionState } from '../state/SessionState.js';
import { SttProvider, TtsProvider } from '../providers/types.js';
import { TranscriptSink } from '../services/TranscriptSink.js';

export function registerToggleVoiceInput(
  _stt: SttProvider,
  _tts: TtsProvider,
  state: SessionState,
  _sink: TranscriptSink,
  _panel: ClaudeIoPanel,
  logger: Logger,
  _context: vscode.ExtensionContext,
): vscode.Disposable {
  return vscode.commands.registerCommand('claude-io.toggleVoiceInput', async () => {
    logger.info('command: claude-io.toggleVoiceInput');
    if (state.isRecording) {
      await vscode.commands.executeCommand('claude-io.stopVoiceInput');
    } else {
      await vscode.commands.executeCommand('claude-io.startVoiceInput');
    }
  });
}
