import * as vscode from 'vscode';
import { Logger } from '../services/Logger.js';
import { ClaudeIoPanel } from '../webview/ClaudeIoPanel.js';

export function registerShowPanel(panel: ClaudeIoPanel, logger: Logger): vscode.Disposable {
  return vscode.commands.registerCommand('claude-io.showPanel', async () => {
    logger.info('command: claude-io.showPanel');
    try {
      await panel.reveal();
    } catch (err) {
      logger.error('showPanel failed', err);
      void vscode.window.showErrorMessage(
        `claude-io: failed to open panel — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
}
