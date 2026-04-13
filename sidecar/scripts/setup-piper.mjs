#!/usr/bin/env node
/**
 * claude-io sidecar — Piper TTS setup script.
 *
 * Downloads the Piper binary for the current platform and a small English
 * voice model (en_US-amy-low, ~15 MB) into ~/.claude-io/piper and
 * ~/.claude-io/voices respectively. Run once per machine.
 *
 * Usage:
 *   node sidecar/scripts/setup-piper.mjs
 *
 * This script is standalone — no external dependencies, uses only the
 * Node standard library. It's in .mjs form so you can run it directly
 * without a build step.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

// ---------- Config ----------

const PIPER_VERSION = '2023.11.14-2';
const PIPER_RELEASE_BASE = `https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}`;

const VOICE_NAME = 'en_GB-alan-medium';
const VOICE_RELPATH = 'en/en_GB/alan/medium';
const HUGGINGFACE_BASE =
  'https://huggingface.co/rhasspy/piper-voices/resolve/main';

const CACHE_DIR = path.join(os.homedir(), '.claude-io');
const PIPER_DIR = path.join(CACHE_DIR, 'piper');
const VOICES_DIR = path.join(CACHE_DIR, 'voices');

// ---------- Platform detection ----------

function detectPiperAsset() {
  const platform = os.platform();
  const arch = os.arch();

  if (platform === 'win32' && arch === 'x64') {
    return {
      assetName: `piper_windows_amd64.zip`,
      archiveKind: 'zip',
      binaryName: 'piper.exe',
    };
  }
  if (platform === 'darwin' && arch === 'x64') {
    return {
      assetName: `piper_macos_x64.tar.gz`,
      archiveKind: 'targz',
      binaryName: 'piper',
    };
  }
  if (platform === 'darwin' && arch === 'arm64') {
    return {
      assetName: `piper_macos_aarch64.tar.gz`,
      archiveKind: 'targz',
      binaryName: 'piper',
    };
  }
  if (platform === 'linux' && arch === 'x64') {
    return {
      assetName: `piper_linux_x86_64.tar.gz`,
      archiveKind: 'targz',
      binaryName: 'piper',
    };
  }
  if (platform === 'linux' && arch === 'arm64') {
    return {
      assetName: `piper_linux_aarch64.tar.gz`,
      archiveKind: 'targz',
      binaryName: 'piper',
    };
  }
  throw new Error(`Unsupported platform: ${platform}/${arch}`);
}

// ---------- Helpers ----------

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function downloadFile(url, destPath) {
  process.stdout.write(`  fetching ${url}\n`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`download failed: ${res.status} ${res.statusText} for ${url}`);
  }
  if (!res.body) {
    throw new Error(`download failed: empty body for ${url}`);
  }
  const webStream = Readable.fromWeb(res.body);
  await pipeline(webStream, fs.createWriteStream(destPath));
}

function fileSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return -1;
  }
}

function extractArchive(archivePath, destDir, kind) {
  if (kind === 'targz') {
    const r = spawnSync('tar', ['-xzf', archivePath, '-C', destDir], {
      stdio: 'inherit',
    });
    if (r.status !== 0) {
      throw new Error(`tar extract failed (exit ${r.status})`);
    }
    return;
  }
  if (kind === 'zip') {
    // Windows: PowerShell Expand-Archive is built-in.
    const r = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
      ],
      { stdio: 'inherit' },
    );
    if (r.status !== 0) {
      throw new Error(`PowerShell Expand-Archive failed (exit ${r.status})`);
    }
    return;
  }
  throw new Error(`Unknown archive kind: ${kind}`);
}

function findFileRecursive(dir, filename) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findFileRecursive(full, filename);
      if (hit) return hit;
    } else if (entry.isFile() && entry.name === filename) {
      return full;
    }
  }
  return null;
}

// ---------- Main ----------

async function main() {
  console.log('claude-io sidecar — Piper TTS setup');
  console.log(`cache dir: ${CACHE_DIR}`);
  await ensureDir(PIPER_DIR);
  await ensureDir(VOICES_DIR);

  const asset = detectPiperAsset();
  const binaryTargetPath = path.join(PIPER_DIR, asset.binaryName);

  // --- Piper binary ---
  if (fs.existsSync(binaryTargetPath) && fileSize(binaryTargetPath) > 0) {
    console.log(`piper: already installed at ${binaryTargetPath}`);
  } else {
    console.log(`piper: downloading ${asset.assetName} (${PIPER_VERSION})`);
    const archivePath = path.join(PIPER_DIR, asset.assetName);
    try {
      await downloadFile(`${PIPER_RELEASE_BASE}/${asset.assetName}`, archivePath);
      console.log(`piper: extracting to ${PIPER_DIR}`);
      extractArchive(archivePath, PIPER_DIR, asset.archiveKind);
      // Piper releases extract into a subdirectory (e.g. piper/piper.exe).
      // We want the binary directly under PIPER_DIR so piperPaths.ts can find it.
      if (!fs.existsSync(binaryTargetPath)) {
        const found = findFileRecursive(PIPER_DIR, asset.binaryName);
        if (!found) {
          throw new Error(`piper: binary ${asset.binaryName} not found after extract`);
        }
        if (found !== binaryTargetPath) {
          // Move the whole piper install one level up so DLLs / .so files
          // stay co-located with the binary.
          const subdir = path.dirname(found);
          const entries = fs.readdirSync(subdir, { withFileTypes: true });
          for (const entry of entries) {
            const from = path.join(subdir, entry.name);
            const to = path.join(PIPER_DIR, entry.name);
            if (fs.existsSync(to)) {
              fs.rmSync(to, { recursive: true, force: true });
            }
            fs.renameSync(from, to);
          }
          // Clean up the now-empty subdir
          try {
            fs.rmdirSync(subdir);
          } catch {
            // may still have hidden files, ignore
          }
        }
      }
      await fsp.unlink(archivePath);
      console.log(`piper: installed at ${binaryTargetPath}`);
    } catch (err) {
      console.error(`piper: install failed: ${err.message}`);
      process.exit(1);
    }
  }

  // --- Voice model ---
  const onnxTarget = path.join(VOICES_DIR, `${VOICE_NAME}.onnx`);
  const jsonTarget = path.join(VOICES_DIR, `${VOICE_NAME}.onnx.json`);

  if (fs.existsSync(onnxTarget) && fs.existsSync(jsonTarget)) {
    console.log(`voice: ${VOICE_NAME} already installed`);
  } else {
    console.log(`voice: downloading ${VOICE_NAME}`);
    try {
      await downloadFile(
        `${HUGGINGFACE_BASE}/${VOICE_RELPATH}/${VOICE_NAME}.onnx`,
        onnxTarget,
      );
      await downloadFile(
        `${HUGGINGFACE_BASE}/${VOICE_RELPATH}/${VOICE_NAME}.onnx.json`,
        jsonTarget,
      );
      console.log(`voice: installed at ${onnxTarget}`);
    } catch (err) {
      console.error(`voice: install failed: ${err.message}`);
      process.exit(1);
    }
  }

  console.log();
  console.log('Setup complete.');
  console.log(`  binary: ${binaryTargetPath}`);
  console.log(`  model : ${onnxTarget}`);
  console.log();
  console.log('Test it:');
  console.log(`  echo '{"id":1,"method":"tts.speak","params":{"text":"Hello from claude-io."}}' | node sidecar/dist/main.js`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
