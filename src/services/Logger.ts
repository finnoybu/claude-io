import * as vscode from 'vscode';

/**
 * Structured logging via a VSCode OutputChannel.
 *
 * Users see this via the "claude-io: Show Log" command or by selecting
 * "claude-io" from the Output view channel dropdown. All logs are timestamped.
 */
export class Logger implements vscode.Disposable {
  private readonly channel: vscode.OutputChannel;

  constructor(name: string) {
    this.channel = vscode.window.createOutputChannel(name);
  }

  info(message: string, ...details: unknown[]): void {
    this.write('INFO', message, details);
  }

  warn(message: string, ...details: unknown[]): void {
    this.write('WARN', message, details);
  }

  error(message: string, ...details: unknown[]): void {
    this.write('ERROR', message, details);
  }

  show(preserveFocus = true): void {
    this.channel.show(preserveFocus);
  }

  dispose(): void {
    this.channel.dispose();
  }

  private write(level: string, message: string, details: unknown[]): void {
    const ts = new Date().toISOString();
    let line = `[${ts}] ${level} ${message}`;
    if (details.length > 0) {
      const serialized = details
        .map((d) => {
          if (d instanceof Error) {
            return `${d.message}\n${d.stack ?? ''}`;
          }
          try {
            return JSON.stringify(d);
          } catch {
            return String(d);
          }
        })
        .join(' ');
      line += ` ${serialized}`;
    }
    this.channel.appendLine(line);
  }
}
