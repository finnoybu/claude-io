/**
 * Piper TTS driver.
 *
 * Spawns the piper binary, feeds it text on stdin, captures the generated
 * WAV to a temp file, then plays the file via platform-native audio tools.
 *
 * Cancellation: pass an AbortSignal through SpeakOptions.signal and both
 * the synthesis step and the playback step will be torn down cleanly.
 */

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { playWavFile } from '../audio/play.js';
import { resolvePiperPaths } from './piperPaths.js';

export interface SpeakOptions {
  /** Voice name (e.g. "en_US-amy-low"). Defaults to env/resolvePiperPaths default. */
  voice?: string;
  /** Abort signal to cancel synthesis/playback mid-stream. */
  signal?: AbortSignal;
  /** Optional progress/log callback. */
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

async function ensureTempDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), 'claude-io-sidecar');
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Synthesize and play a block of text. Resolves when playback completes.
 */
export async function speak(text: string, opts: SpeakOptions = {}): Promise<void> {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return;
  }
  const log = opts.onLog ?? (() => {});

  const paths = resolvePiperPaths(opts.voice);
  log('info', `piper: using binary=${paths.binary} model=${paths.modelOnnx}`);

  const tmpDir = await ensureTempDir();
  const outFile = path.join(tmpDir, `tts-${Date.now()}-${randomBytes(4).toString('hex')}.wav`);

  try {
    await runPiper(paths.binary, paths.modelOnnx, trimmed, outFile, opts);
    log('info', `piper: wrote ${outFile}`);
    await playWavFile(outFile, { signal: opts.signal });
    log('info', 'piper: playback finished');
  } finally {
    // Best-effort cleanup. Don't throw if the temp file is already gone.
    try {
      await fs.unlink(outFile);
    } catch {
      // ignore
    }
  }
}

async function runPiper(
  binary: string,
  modelPath: string,
  text: string,
  outFile: string,
  opts: SpeakOptions,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(binary, ['--model', modelPath, '--output_file', outFile], {
      stdio: ['pipe', 'pipe', 'pipe'],
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
      reject(new Error(`piper: spawn failed: ${err.message}`));
    });

    child.on('exit', (code, signal) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (signal === 'SIGTERM' && opts.signal?.aborted) {
        reject(new DOMException('Piper synthesis aborted', 'AbortError'));
        return;
      }
      if (code === 0) {
        resolve();
      } else {
        const trimmed = stderr.trim();
        reject(
          new Error(
            `piper: exited with code ${code} signal=${signal ?? 'null'}${trimmed ? ` stderr=${trimmed}` : ''}`,
          ),
        );
      }
    });

    // Write the text to piper's stdin and close stdin so it knows we're done.
    child.stdin?.write(text);
    child.stdin?.end();
  });
}
