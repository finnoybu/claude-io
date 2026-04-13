/**
 * Resolves the whisper.cpp binary and model paths.
 *
 * Order of precedence:
 *   1. Environment variables CLAUDE_IO_WHISPER_BIN_DIR and
 *      CLAUDE_IO_WHISPER_MODEL override everything.
 *   2. Standard cache location:
 *        ~/.claude-io/whisper/Release/    (unpacked Windows release zip)
 *        ~/.claude-io/whisper-models/     (downloaded ggml-*.bin models)
 *      The binary directory is used as-is; whisper-stream.exe and its
 *      dependent DLLs (SDL2, whisper, ggml-*) must all live there.
 *
 * Throws with a useful "run setup.mjs first" error if anything is missing.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

export interface WhisperPaths {
  /** Directory containing whisper-stream.exe + its DLLs. */
  binDir: string;
  /** Absolute path to whisper-stream.exe (or whisper-stream on Unix). */
  streamExe: string;
  /** Absolute path to whisper-cli.exe (or whisper-cli on Unix). */
  cliExe: string;
  /** Absolute path to the ggml model file (e.g. ggml-base.bin). */
  modelPath: string;
}

const DEFAULT_MODEL_NAME = 'ggml-base.bin';

export function claudeIoCacheDir(): string {
  return path.join(os.homedir(), '.claude-io');
}

function exeName(base: string): string {
  return os.platform() === 'win32' ? `${base}.exe` : base;
}

export function whisperBinDir(): string {
  const override = process.env['CLAUDE_IO_WHISPER_BIN_DIR'];
  if (override && fs.existsSync(override)) {
    return override;
  }
  // Windows release zip extracts to whisper/Release/. On other platforms
  // the layout varies; we'll add per-platform handling if/when non-Windows
  // support becomes real.
  const cached = path.join(claudeIoCacheDir(), 'whisper', 'Release');
  if (fs.existsSync(cached)) {
    return cached;
  }
  throw new Error(
    `whisper binary directory not found. Expected ${cached} or CLAUDE_IO_WHISPER_BIN_DIR. ` +
      `Run: node sidecar/scripts/setup.mjs`,
  );
}

export function whisperModelPath(modelName: string = DEFAULT_MODEL_NAME): string {
  const override = process.env['CLAUDE_IO_WHISPER_MODEL'];
  if (override && fs.existsSync(override)) {
    return override;
  }
  const cached = path.join(claudeIoCacheDir(), 'whisper-models', modelName);
  if (fs.existsSync(cached)) {
    return cached;
  }
  throw new Error(
    `whisper model not found. Expected ${cached} or CLAUDE_IO_WHISPER_MODEL. ` +
      `Run: node sidecar/scripts/setup.mjs`,
  );
}

export function resolveWhisperPaths(modelName?: string): WhisperPaths {
  const binDir = whisperBinDir();
  const streamExe = path.join(binDir, exeName('whisper-stream'));
  const cliExe = path.join(binDir, exeName('whisper-cli'));
  if (!fs.existsSync(streamExe)) {
    throw new Error(`whisper-stream executable not found at ${streamExe}`);
  }
  const modelPath = whisperModelPath(modelName);
  return { binDir, streamExe, cliExe, modelPath };
}
