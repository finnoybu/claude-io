/**
 * Resolves the piper binary and voice-model paths.
 *
 * Order of precedence (first hit wins):
 *   1. Environment variables CLAUDE_IO_PIPER_BIN / CLAUDE_IO_PIPER_MODEL.
 *   2. Standard cache location: ~/.claude-io/piper/ and ~/.claude-io/voices/.
 *      Binary name is platform-specific (piper.exe on Windows, piper elsewhere).
 *      Default voice model: en_US-amy-low.onnx with its .onnx.json sidecar.
 *
 * If neither the env var nor the cached file is present, the relevant
 * getter throws so callers can surface a useful "run setup-piper.mjs first"
 * error instead of a cryptic ENOENT.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

export interface PiperPaths {
  binary: string;
  modelOnnx: string;
  modelJson: string;
}

const DEFAULT_VOICE_NAME = 'en_GB-alan-medium';

export function claudeIoCacheDir(): string {
  return path.join(os.homedir(), '.claude-io');
}

export function piperBinaryPath(): string {
  const override = process.env['CLAUDE_IO_PIPER_BIN'];
  if (override && fs.existsSync(override)) {
    return override;
  }
  const binaryName = os.platform() === 'win32' ? 'piper.exe' : 'piper';
  const cached = path.join(claudeIoCacheDir(), 'piper', binaryName);
  if (fs.existsSync(cached)) {
    return cached;
  }
  throw new Error(
    `piper binary not found. Expected ${cached} or CLAUDE_IO_PIPER_BIN. ` +
      `Run: node sidecar/scripts/setup-piper.mjs`,
  );
}

export function piperModelPaths(voiceName: string = DEFAULT_VOICE_NAME): { onnx: string; json: string } {
  const overrideOnnx = process.env['CLAUDE_IO_PIPER_MODEL'];
  if (overrideOnnx && fs.existsSync(overrideOnnx)) {
    const overrideJson = `${overrideOnnx}.json`;
    if (!fs.existsSync(overrideJson)) {
      throw new Error(
        `piper model override points at ${overrideOnnx} but ${overrideJson} is missing`,
      );
    }
    return { onnx: overrideOnnx, json: overrideJson };
  }
  const voicesDir = path.join(claudeIoCacheDir(), 'voices');
  const onnx = path.join(voicesDir, `${voiceName}.onnx`);
  const json = path.join(voicesDir, `${voiceName}.onnx.json`);
  if (!fs.existsSync(onnx) || !fs.existsSync(json)) {
    throw new Error(
      `piper voice model not found. Expected ${onnx} and ${json}, or set CLAUDE_IO_PIPER_MODEL. ` +
        `Run: node sidecar/scripts/setup-piper.mjs`,
    );
  }
  return { onnx, json };
}

export function resolvePiperPaths(voiceName: string = DEFAULT_VOICE_NAME): PiperPaths {
  const binary = piperBinaryPath();
  const { onnx, json } = piperModelPaths(voiceName);
  return { binary, modelOnnx: onnx, modelJson: json };
}
