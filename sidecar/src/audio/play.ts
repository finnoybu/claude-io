/**
 * Cross-platform WAV file playback.
 *
 * Shells out to platform-native tools so we don't need native node modules.
 * The playback is blocking — the returned promise resolves when the audio
 * has finished playing (or rejects on error).
 *
 * Platform matrix:
 *   - Windows: PowerShell's System.Media.SoundPlayer.PlaySync()
 *   - macOS:   afplay
 *   - Linux:   paplay (PulseAudio), falling back to aplay (ALSA)
 */

import { spawn } from 'node:child_process';
import * as os from 'node:os';
import * as fs from 'node:fs';

export interface PlayOptions {
  /** Abort signal to cancel playback mid-stream. */
  signal?: AbortSignal;
}

/**
 * Play a WAV file from disk, blocking until playback completes.
 */
export async function playWavFile(filePath: string, opts: PlayOptions = {}): Promise<void> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`playWavFile: file does not exist: ${filePath}`);
  }

  const platform = os.platform();
  let command: string;
  let args: string[];

  if (platform === 'win32') {
    // PowerShell SoundPlayer plays WAV synchronously. Escape the path for
    // PowerShell single-quoted string literals (just double-up single quotes).
    const escaped = filePath.replace(/'/g, "''");
    command = 'powershell';
    args = [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(New-Object Media.SoundPlayer '${escaped}').PlaySync()`,
    ];
  } else if (platform === 'darwin') {
    command = 'afplay';
    args = [filePath];
  } else {
    // Linux — try paplay first (PulseAudio is ubiquitous on modern distros),
    // then fall back to aplay. We detect the first available binary at run time.
    const paplayAvailable = await commandExists('paplay');
    if (paplayAvailable) {
      command = 'paplay';
      args = [filePath];
    } else {
      const aplayAvailable = await commandExists('aplay');
      if (!aplayAvailable) {
        throw new Error(
          'playWavFile: neither paplay nor aplay is available. Install PulseAudio or ALSA utils.',
        );
      }
      command = 'aplay';
      args = ['-q', filePath];
    }
  }

  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    const onAbort = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort();
      } else {
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    child.on('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort);
      reject(new Error(`playWavFile: spawn failed for ${command}: ${err.message}`));
    });
    child.on('exit', (code, signal) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (signal === 'SIGTERM' && opts.signal?.aborted) {
        reject(new DOMException('Playback aborted', 'AbortError'));
        return;
      }
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `playWavFile: ${command} exited with code ${code} signal=${signal ?? 'null'}${stderr ? ` stderr=${stderr.trim()}` : ''}`,
          ),
        );
      }
    });
  });
}

async function commandExists(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const which = spawn('which', [cmd], { stdio: 'ignore' });
    which.on('exit', (code) => resolve(code === 0));
    which.on('error', () => resolve(false));
  });
}
