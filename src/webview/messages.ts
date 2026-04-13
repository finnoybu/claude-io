/**
 * Message protocol between the extension host and the webview.
 *
 * These types are the single source of truth for host <-> webview communication.
 * The extension host imports from here directly. The webview JS
 * (media/webview.js) ships as raw JavaScript and cannot import TS types —
 * it mirrors this protocol by convention. Keep both in sync.
 */

// ======================================================================
// Host -> Webview
// ======================================================================

export type HostToWebviewMessage =
  | { type: 'stt.start'; payload: { language: string; continuous: boolean } }
  | { type: 'stt.stop' }
  | { type: 'tts.speak'; payload: { text: string; voice?: string; rate?: number; pitch?: number } }
  | { type: 'tts.cancel' }
  | { type: 'camera.enable' }
  | { type: 'camera.capture' }
  | { type: 'camera.disable' }
  | { type: 'ui.setMode'; payload: { mode: UiMode } }
  | { type: 'ai.setState'; payload: { state: AiPresenceState; utterance?: string } };

export type UiMode = 'idle' | 'recording' | 'speaking' | 'camera';

/**
 * Visual state of the "AI presence" element in the webview.
 * See the `media/webview.js` presence renderer for how each state is animated.
 */
export type AiPresenceState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'processing'
  | 'error';

// ======================================================================
// Webview -> Host
// ======================================================================

export type WebviewToHostMessage =
  | { type: 'ready'; payload: WebviewCapabilities }
  | { type: 'stt.interim'; payload: { text: string } }
  | { type: 'stt.final'; payload: { text: string } }
  | { type: 'stt.error'; payload: ProviderErrorPayload }
  | { type: 'stt.ended' }
  | { type: 'tts.started' }
  | { type: 'tts.ended' }
  | { type: 'tts.error'; payload: ProviderErrorPayload }
  | { type: 'camera.enabled' }
  | { type: 'camera.frame'; payload: { dataUrl: string; width: number; height: number } }
  | { type: 'camera.disabled' }
  | { type: 'camera.error'; payload: ProviderErrorPayload }
  | { type: 'log'; payload: { level: LogLevel; message: string } };

export interface WebviewCapabilities {
  speechRecognitionAvailable: boolean;
  speechSynthesisAvailable: boolean;
  getUserMediaAvailable: boolean;
}

export interface ProviderErrorPayload {
  code: string;
  message: string;
}

export type LogLevel = 'info' | 'warn' | 'error';
