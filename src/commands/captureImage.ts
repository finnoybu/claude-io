import * as vscode from 'vscode';
import { Logger } from '../services/Logger.js';
import { ClaudeIoPanel } from '../webview/ClaudeIoPanel.js';
import { SessionState } from '../state/SessionState.js';
import { VisionCaptureProvider } from '../providers/types.js';
import { ImageSink } from '../services/ImageSink.js';

export function registerCaptureImage(
  panel: ClaudeIoPanel,
  vision: VisionCaptureProvider,
  sink: ImageSink,
  state: SessionState,
  logger: Logger,
): vscode.Disposable {
  return vscode.commands.registerCommand('claude-io.captureImage', async () => {
    logger.info('command: claude-io.captureImage');
    let weEnabledCamera = false;
    try {
      await panel.ensurePanel();
      const available = await vision.isAvailable();
      if (!available) {
        logger.warn('captureImage: vision provider not available');
        void vscode.window.showErrorMessage(
          'claude-io: camera access (getUserMedia) is not available in this environment. ' +
            'Try running "claude-io: Show Log" for details.',
        );
        return;
      }

      if (!state.isCameraEnabled) {
        await vision.enable();
        state.isCameraEnabled = true;
        weEnabledCamera = true;
        // Brief warmup so the first captured frame isn't black from a
        // not-yet-initialized stream.
        await new Promise((resolve) => setTimeout(resolve, 400));
      }

      const frame = await vision.captureFrame();
      const filePath = await sink.save(frame.dataUrl, frame.width, frame.height);
      state.lastImagePath = filePath;
    } catch (err) {
      logger.error('captureImage failed', err);
      void vscode.window
        .showErrorMessage(
          `claude-io: failed to capture image — ${err instanceof Error ? err.message : String(err)}`,
          'Show Log',
        )
        .then((selection) => {
          if (selection === 'Show Log') {
            logger.show();
          }
        });
    } finally {
      // Auto-disable the camera if this command enabled it — the MVP is
      // single-frame capture, not live video. Prevents the webcam LED
      // from staying on indefinitely after a one-shot capture.
      if (weEnabledCamera) {
        try {
          await vision.disable();
        } catch (err) {
          logger.warn('captureImage: failed to disable camera', err);
        }
        state.isCameraEnabled = false;
      }
    }
  });
}
