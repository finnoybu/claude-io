import * as vscode from 'vscode';
import { Logger } from './Logger.js';
import { writeBase64Png } from '../util/tempFile.js';

/**
 * Routes captured camera frames to a destination.
 *
 * MVP: only 'tempFile' is supported — writes a PNG to the OS temp dir,
 * copies the absolute path to the clipboard, and offers to reveal/open
 * the file.
 */
export class ImageSink {
  constructor(private readonly logger: Logger) {}

  async save(dataUrl: string, width: number, height: number): Promise<string> {
    const filePath = await writeBase64Png(dataUrl);
    this.logger.info(`ImageSink: wrote ${width}x${height} frame to ${filePath}`);
    await vscode.env.clipboard.writeText(filePath);

    const fileUri = vscode.Uri.file(filePath);
    void this.showCaptureNotification(fileUri);
    return filePath;
  }

  private async showCaptureNotification(fileUri: vscode.Uri): Promise<void> {
    const selection = await vscode.window.showInformationMessage(
      `claude-io: captured frame saved (path copied to clipboard).`,
      'Reveal in Explorer',
      'Open Image',
      'Show Log',
    );
    switch (selection) {
      case 'Reveal in Explorer':
        await vscode.commands.executeCommand('revealFileInOS', fileUri);
        return;
      case 'Open Image':
        await vscode.commands.executeCommand('vscode.open', fileUri);
        return;
      case 'Show Log':
        this.logger.show();
        return;
      default:
        return;
    }
  }
}
