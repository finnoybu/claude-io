import * as vscode from 'vscode';

const KEY = 'claudeIo.networkNoticeShown';

/**
 * Shows a one-time informational notice about Web Speech API's network
 * behavior the first time STT is used in a given installation. Remembered
 * in globalState so the user only sees it once.
 */
export async function showNetworkNoticeOnce(context: vscode.ExtensionContext): Promise<void> {
  const shown = context.globalState.get<boolean>(KEY, false);
  if (shown) {
    return;
  }

  await context.globalState.update(KEY, true);
  const selection = await vscode.window.showInformationMessage(
    'claude-io: Web Speech API speech recognition typically routes audio to a cloud service ' +
      '(Google, in Chromium-based runtimes). Your voice is transmitted to that service for recognition. ' +
      'You can disable web-speech STT via the claudeIo.allowNetworkSpeechRecognition setting. ' +
      'TTS is unaffected and runs locally.',
    'Open Settings',
    'Dismiss',
  );
  if (selection === 'Open Settings') {
    await vscode.commands.executeCommand(
      'workbench.action.openSettings',
      'claudeIo.allowNetworkSpeechRecognition',
    );
  }
}
