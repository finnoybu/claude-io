import * as vscode from 'vscode';
import { Logger } from './services/Logger.js';
import { ClaudeIoPanel } from './webview/ClaudeIoPanel.js';
import { WebSpeechSttProvider } from './providers/WebSpeechSttProvider.js';
import { WebSpeechTtsProvider } from './providers/WebSpeechTtsProvider.js';
import { WebviewVisionProvider } from './providers/WebviewVisionProvider.js';
import { SessionState } from './state/SessionState.js';
import { TranscriptSink } from './services/TranscriptSink.js';
import { ImageSink } from './services/ImageSink.js';
import { SidecarManager } from './sidecar/SidecarManager.js';
import { registerShowPanel } from './commands/showPanel.js';
import { registerStartVoiceInput } from './commands/startVoiceInput.js';
import { registerStopVoiceInput } from './commands/stopVoiceInput.js';
import { registerToggleVoiceInput } from './commands/toggleVoiceInput.js';
import { registerSpeakSelection } from './commands/speakSelection.js';
import { registerStopSpeaking } from './commands/stopSpeaking.js';
import { registerCaptureImage } from './commands/captureImage.js';
import { registerShowLog } from './commands/showLog.js';

let logger: Logger;
let panel: ClaudeIoPanel;
let state: SessionState;
let sttProvider: WebSpeechSttProvider;
let ttsProvider: WebSpeechTtsProvider;
let visionProvider: WebviewVisionProvider;
let transcriptSink: TranscriptSink;
let imageSink: ImageSink;
let sidecarManager: SidecarManager;

export function activate(context: vscode.ExtensionContext): void {
  logger = new Logger('claude-io');
  logger.info('Activating claude-io extension');

  state = new SessionState();
  panel = new ClaudeIoPanel(context.extensionUri, logger, state);

  sttProvider = new WebSpeechSttProvider(panel, logger);
  ttsProvider = new WebSpeechTtsProvider(panel, logger);
  visionProvider = new WebviewVisionProvider(panel, logger);

  transcriptSink = new TranscriptSink(logger);
  imageSink = new ImageSink(logger);

  // Spawn the audio sidecar process and verify the IPC loop works.
  // This is fire-and-forget at activation — we don't block the extension
  // from loading if the sidecar has issues, we just log and carry on.
  sidecarManager = new SidecarManager(context.extensionUri, logger);
  void sidecarManager
    .start()
    .then(() => sidecarManager.request('ping'))
    .then((pong) => {
      logger.info('SidecarManager: ping successful', pong);
    })
    .catch((err) => {
      logger.error('SidecarManager: startup failed', err);
    });

  const disposables: vscode.Disposable[] = [
    registerShowPanel(panel, logger),
    registerStartVoiceInput(panel, sttProvider, ttsProvider, state, transcriptSink, logger, context),
    registerStopVoiceInput(sttProvider, state, logger),
    registerToggleVoiceInput(sttProvider, ttsProvider, state, transcriptSink, panel, logger, context),
    registerSpeakSelection(ttsProvider, sttProvider, state, logger),
    registerStopSpeaking(ttsProvider, state, logger),
    registerCaptureImage(panel, visionProvider, imageSink, state, logger),
    registerShowLog(logger),
  ];

  context.subscriptions.push(
    ...disposables,
    sttProvider,
    ttsProvider,
    visionProvider,
    sidecarManager,
    panel,
    logger,
  );
  logger.info('claude-io extension activated successfully');
}

export function deactivate(): void {
  if (logger) {
    logger.info('Deactivating claude-io extension');
  }
}
