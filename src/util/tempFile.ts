import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEMP_SUBDIR = 'claude-io';

/** Maximum accepted data URL size (about 24 MB of actual PNG after base64 decode). */
const MAX_DATA_URL_BYTES = 32 * 1024 * 1024;

/** PNG magic bytes — a well-formed PNG starts with 89 50 4E 47 0D 0A 1A 0A. */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Ensures the claude-io temp directory exists under the OS temp dir and
 * returns its absolute path. On POSIX this is created with mode 0o700 so
 * other local users on shared hosts cannot read the saved frames.
 */
export async function ensureTempDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), TEMP_SUBDIR);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Writes a base64 PNG (from a strict `data:image/png;base64,...` URL) to a
 * new file under the claude-io temp directory and returns the absolute path.
 *
 * Hardened against malformed input and trivial symlink / TOCTOU attacks:
 *
 * - The dataUrl must exactly match `data:image/png;base64,<base64>` with
 *   only standard base64 characters (and optional padding).
 * - The encoded length is capped so a hostile oversized input cannot
 *   allocate arbitrary memory or fill the disk.
 * - The decoded bytes must start with the PNG magic number — we refuse to
 *   write arbitrary content to a `.png` file.
 * - The output file uses a random suffix and is opened with the `wx` flag
 *   (exclusive create, fails if the target already exists), so a symlink
 *   pre-created by another local user cannot be followed.
 */
export async function writeBase64Png(dataUrl: string): Promise<string> {
  if (typeof dataUrl !== 'string' || dataUrl.length === 0) {
    throw new Error('writeBase64Png: expected a non-empty string');
  }
  if (dataUrl.length > MAX_DATA_URL_BYTES) {
    throw new Error(`writeBase64Png: data URL exceeds ${MAX_DATA_URL_BYTES} bytes`);
  }
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) {
    throw new Error('writeBase64Png: expected a strict data:image/png;base64 URL');
  }
  const base64 = match[1]!;
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length < PNG_MAGIC.length) {
    throw new Error('writeBase64Png: decoded bytes too short to be a PNG');
  }
  for (let i = 0; i < PNG_MAGIC.length; i += 1) {
    if (buffer[i] !== PNG_MAGIC[i]) {
      throw new Error('writeBase64Png: decoded bytes are not a PNG');
    }
  }

  const dir = await ensureTempDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = randomBytes(6).toString('hex');
  const file = path.join(dir, `capture-${timestamp}-${suffix}.png`);

  // Exclusive-create open — fails instead of following an existing symlink.
  const handle = await fs.open(file, 'wx', 0o600);
  try {
    await handle.writeFile(buffer);
  } finally {
    await handle.close();
  }
  return file;
}
