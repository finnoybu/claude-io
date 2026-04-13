/**
 * In-memory state for a single VSCode session.
 *
 * Intentionally not persisted — session state is ephemeral. If something
 * needs durable storage (e.g., "has the user seen the privacy notice yet"),
 * use vscode.ExtensionContext.globalState or .workspaceState directly in the
 * relevant command, not here.
 */
export class SessionState {
  isRecording = false;
  isSpeaking = false;
  isCameraEnabled = false;
  currentInterim = '';
  currentFinal = '';
  lastImagePath: string | undefined = undefined;
  lastTranscript: string | undefined = undefined;

  reset(): void {
    this.isRecording = false;
    this.isSpeaking = false;
    this.isCameraEnabled = false;
    this.currentInterim = '';
    this.currentFinal = '';
  }
}
