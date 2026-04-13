/**
 * Wraps whisper.cpp's whisper-stream.exe for mic capture + streaming STT.
 *
 * whisper-stream is an interactive terminal program that:
 *   1. Uses SDL2 to capture audio from the default (or selected) input device.
 *   2. Every `--step N` milliseconds, runs Whisper inference on the latest
 *      `--length N` milliseconds of audio.
 *   3. Prints the transcript to stdout, using ANSI erase-line escape codes
 *      to update the "current" transcription in place. This is great for
 *      humans watching a terminal, and manageable for programmatic parsing
 *      if we strip the escape sequences and track line breaks.
 *
 * We spawn it as a child process, pipe stdout through a small parser, and
 * emit two kinds of events via a callback:
 *   - 'interim':  a new partial transcript line (whisper is still refining)
 *   - 'log':      status or init output (model loaded, samples processed)
 *
 * There is no explicit 'final' event in whisper-stream's output — streaming
 * Whisper operates on a sliding window, not a strict turn model. The host
 * accumulates interim text and treats the last-seen line as the final
 * transcript when the user asks to stop.
 */

import { ChildProcess, spawn } from 'node:child_process';
import { resolveWhisperPaths } from '../stt/whisperPaths.js';

// ANSI escape sequences used by whisper-stream's live-update output.
// Matches CSI sequences: ESC [ <params> <final byte>.
// eslint-disable-next-line no-control-regex
const ANSI_ESC_RE = /\u001b\[[0-9;?]*[A-Za-z]/g;

export interface WhisperStreamOptions {
  /** Model override. Defaults to ggml-base.bin in the standard cache. */
  model?: string;
  /** BCP-47 language tag (default 'en'). */
  language?: string;
  /** Audio step size in milliseconds (default 2000). */
  stepMs?: number;
  /** Audio length window in milliseconds (default 8000). */
  lengthMs?: number;
  /** Number of threads to use. Default 4. */
  threads?: number;
  /** Voice activity detection threshold. Default 0.6. */
  vadThreshold?: number;
  /** Capture device ID. -1 = default. */
  captureDevice?: number;
}

export type WhisperStreamEvent =
  | { type: 'started' }
  | { type: 'interim'; text: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'exit'; code: number | null; signal: NodeJS.Signals | null }
  | { type: 'error'; message: string };

export type WhisperStreamListener = (event: WhisperStreamEvent) => void;

/**
 * A running instance of whisper-stream.exe. Start one via `start()`,
 * stop it via `stop()`. Events are delivered through the listener given
 * at construction time.
 */
export class WhisperStreamSession {
  private process: ChildProcess | undefined;
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private lastInterimText = '';
  private allInterimLines: string[] = [];
  private startedEmitted = false;

  constructor(private readonly listener: WhisperStreamListener) {}

  isRunning(): boolean {
    return this.process !== undefined;
  }

  /** Cumulative interim text seen so far (deduped against the last emission). */
  getAccumulatedTranscript(): string {
    return this.allInterimLines.join(' ').trim();
  }

  /** Start the whisper-stream child process. */
  start(opts: WhisperStreamOptions = {}): void {
    if (this.process) {
      throw new Error('whisper-stream is already running');
    }
    const paths = resolveWhisperPaths(opts.model);
    const args = [
      '-m', paths.modelPath,
      '-t', String(opts.threads ?? 4),
      '--step', String(opts.stepMs ?? 2000),
      '--length', String(opts.lengthMs ?? 8000),
      '-l', opts.language ?? 'en',
      '-vth', String(opts.vadThreshold ?? 0.6),
      '-c', String(opts.captureDevice ?? -1),
    ];
    this.listener({
      type: 'log',
      level: 'info',
      message: `whisper-stream: spawning ${paths.streamExe} with model ${paths.modelPath}`,
    });
    const child = spawn(paths.streamExe, args, {
      cwd: paths.binDir, // so the SDL2.dll / whisper.dll next to it are found
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.process = child;

    child.stdout!.on('data', (chunk: Buffer) => this.onStdout(chunk));
    child.stderr!.on('data', (chunk: Buffer) => this.onStderr(chunk));

    child.on('error', (err) => {
      this.listener({ type: 'error', message: `spawn failed: ${err.message}` });
    });
    child.on('exit', (code, signal) => {
      this.process = undefined;
      this.listener({ type: 'exit', code, signal });
    });
  }

  /**
   * Stop the whisper-stream child process and return the accumulated
   * transcript. Resolves when the process has fully exited.
   */
  async stop(): Promise<string> {
    const child = this.process;
    if (!child) {
      return this.getAccumulatedTranscript();
    }
    return new Promise<string>((resolve) => {
      const onExit = () => {
        resolve(this.getAccumulatedTranscript());
      };
      child.once('exit', onExit);
      // Send SIGTERM first, then escalate to SIGKILL after a grace period.
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      setTimeout(() => {
        if (this.process) {
          try {
            this.process.kill('SIGKILL');
          } catch {
            // ignore
          }
        }
      }, 500);
    });
  }

  // ----- stdout parsing -----

  private onStdout(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString('utf8');
    // whisper-stream emits CR/LF-delimited updates. Split on newlines and
    // flush everything except the (possibly incomplete) trailing fragment.
    let newlineIndex: number;
    while ((newlineIndex = this.stdoutBuffer.indexOf('\n')) !== -1) {
      const rawLine = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      this.handleStdoutLine(rawLine);
    }
  }

  private handleStdoutLine(rawLine: string): void {
    // Strip ANSI escape sequences and also any literal ESC characters
    // left over from multi-byte sequences.
    const stripped = rawLine
      .replace(ANSI_ESC_RE, '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u001b\r]/g, '')
      .trim();
    if (stripped.length === 0) {
      return;
    }
    // Status / init messages from the C++ side start with known prefixes.
    // Route them as log events so the host can surface them when useful.
    if (/^(whisper_|ggml_|SDL_main|init:)/.test(stripped)) {
      this.listener({ type: 'log', level: 'info', message: stripped });
      return;
    }
    // The literal "[Start speaking]" marker means the capture is live
    // and the user can begin talking.
    if (stripped === '[Start speaking]') {
      if (!this.startedEmitted) {
        this.startedEmitted = true;
        this.listener({ type: 'started' });
      }
      return;
    }
    // Everything else is transcript content. Deduplicate against the
    // last emission so we don't flood with identical repeats.
    if (stripped !== this.lastInterimText) {
      this.lastInterimText = stripped;
      this.allInterimLines.push(stripped);
      this.listener({ type: 'interim', text: stripped });
    }
  }

  private onStderr(chunk: Buffer): void {
    this.stderrBuffer += chunk.toString('utf8');
    let newlineIndex: number;
    while ((newlineIndex = this.stderrBuffer.indexOf('\n')) !== -1) {
      const rawLine = this.stderrBuffer.slice(0, newlineIndex);
      this.stderrBuffer = this.stderrBuffer.slice(newlineIndex + 1);
      const stripped = rawLine.replace(ANSI_ESC_RE, '').trim();
      if (stripped.length > 0) {
        this.listener({ type: 'log', level: 'warn', message: `[whisper-stream stderr] ${stripped}` });
      }
    }
  }
}
