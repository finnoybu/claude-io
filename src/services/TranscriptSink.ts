import * as vscode from 'vscode';
import { Logger } from './Logger.js';

/**
 * Routes finalized transcripts to a destination chosen by the user.
 *
 * Destinations:
 * - 'clipboard' (default): writes to the system clipboard.
 * - 'activeEditor': inserts at cursor positions in the active editor.
 *   Falls back to clipboard if no active editor.
 * - 'claudeCode': MVP stub — no stable Claude Code extension API exists yet
 *   for third-party chat injection. Currently falls back to clipboard with
 *   a one-time explanatory notification.
 */
export class TranscriptSink {
  private claudeCodeFallbackNoticeShown = false;

  constructor(private readonly logger: Logger) {}

  async route(text: string): Promise<void> {
    const trimmed = this.sanitize(text.trim());
    if (trimmed.length === 0) {
      this.logger.warn('TranscriptSink: refusing to route empty transcript');
      void vscode.window.showWarningMessage('claude-io: no speech was recognized.');
      return;
    }

    const config = vscode.workspace.getConfiguration('claudeIo');
    const destination = config.get<string>('transcript.destination', 'clipboard');
    this.logger.info(`TranscriptSink: routing ${trimmed.length} chars to ${destination}`);

    switch (destination) {
      case 'activeEditor':
        await this.routeToActiveEditor(trimmed);
        return;
      case 'claudeCode':
        await this.routeToClaudeCode(trimmed);
        return;
      case 'clipboard':
      default:
        await this.routeToClipboard(trimmed);
        return;
    }
  }

  private async routeToClipboard(text: string): Promise<void> {
    await vscode.env.clipboard.writeText(text);
    void this.showTranscriptNotification(text, 'Transcript copied to clipboard');
  }

  private async routeToActiveEditor(text: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this.logger.warn('TranscriptSink: no active editor; falling back to clipboard');
      void vscode.window.showWarningMessage(
        'claude-io: no active editor. Transcript copied to clipboard instead.',
      );
      await this.routeToClipboard(text);
      return;
    }

    const edit = new vscode.WorkspaceEdit();
    for (const selection of editor.selections) {
      edit.insert(editor.document.uri, selection.active, text);
    }
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      this.logger.warn('TranscriptSink: applyEdit failed; falling back to clipboard');
      await this.routeToClipboard(text);
      return;
    }
    void vscode.window.showInformationMessage('claude-io: transcript inserted at cursor.');
  }

  private async routeToClaudeCode(text: string): Promise<void> {
    // MVP: no stable Claude Code integration API yet. Fall back to clipboard
    // with a one-time notification so the user understands why.
    await vscode.env.clipboard.writeText(text);
    if (!this.claudeCodeFallbackNoticeShown) {
      this.claudeCodeFallbackNoticeShown = true;
      void vscode.window.showInformationMessage(
        'claude-io: direct Claude Code injection is not yet implemented. ' +
          'Transcript copied to clipboard — paste into Claude Code chat.',
      );
    } else {
      void vscode.window.showInformationMessage('claude-io: transcript copied to clipboard.');
    }
  }

  /**
   * Strip Unicode bidirectional-override characters and ASCII control chars
   * that could enable "trojan source"-style attacks when inserted into an
   * editor or clipboard. Transcribed speech from Web Speech API is very
   * unlikely to contain these, but defense-in-depth.
   */
  private sanitize(text: string): string {
    return text
      .replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  }

  private async showTranscriptNotification(text: string, title: string): Promise<void> {
    const preview = text.length > 80 ? `${text.slice(0, 80)}…` : text;
    const selection = await vscode.window.showInformationMessage(
      `${title}: "${preview}"`,
      'Show Log',
    );
    if (selection === 'Show Log') {
      this.logger.show();
    }
  }
}
