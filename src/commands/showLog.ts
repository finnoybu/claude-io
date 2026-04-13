import * as vscode from 'vscode';
import { Logger } from '../services/Logger.js';

export function registerShowLog(logger: Logger): vscode.Disposable {
  return vscode.commands.registerCommand('claude-io.showLog', () => {
    logger.show(false);
  });
}
