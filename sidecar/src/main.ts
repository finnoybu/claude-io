/**
 * claude-io sidecar entry point.
 *
 * Spawned as a child process by the VSCode extension. Owns the microphone
 * and speaker, runs STT and TTS inference, communicates with the extension
 * via JSON-RPC on stdin/stdout. See rpc.ts for the protocol.
 *
 * MVP step 1: scaffold only. Responds to `ping` and `shutdown`. Subsequent
 * steps layer in Piper TTS, whisper.cpp STT, mic capture, and audio playback.
 */

import { RpcServer } from './rpc.js';

const VERSION = '0.0.1';

process.on('uncaughtException', (err) => {
  process.stderr.write(
    `sidecar: uncaughtException: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  process.stderr.write(`sidecar: unhandledRejection: ${String(reason)}\n`);
  process.exit(1);
});

const rpc = new RpcServer();

rpc.register('ping', async () => {
  return {
    pong: true,
    version: VERSION,
    timestamp: new Date().toISOString(),
    pid: process.pid,
  };
});

rpc.register('shutdown', async () => {
  rpc.log('info', 'sidecar: shutdown requested');
  // Schedule exit after the response flushes.
  setTimeout(() => process.exit(0), 100);
  return { status: 'shutting-down' };
});

rpc.register('version', async () => {
  return { version: VERSION };
});

rpc.log('info', `sidecar: started (pid=${process.pid}, node=${process.version})`);
