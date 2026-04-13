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
import { speak as piperSpeak } from './tts/piperTts.js';
import { WhisperStreamSession } from './audio/whisperStream.js';

const VERSION = '0.0.1';

// In-flight TTS state so we can cancel mid-playback.
let currentTtsAbort: AbortController | undefined;

// Current STT session, if any. Only one allowed at a time.
let currentSttSession: WhisperStreamSession | undefined;

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

rpc.register('tts.speak', async (params) => {
  const { text, voice } = (params ?? {}) as { text?: unknown; voice?: unknown };
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('tts.speak: expected { text: non-empty string }');
  }
  const voiceName = typeof voice === 'string' && voice.length > 0 ? voice : undefined;

  // Cancel any previous playback before starting new speech.
  currentTtsAbort?.abort();
  const controller = new AbortController();
  currentTtsAbort = controller;

  rpc.event('tts.started', { textLength: text.length });
  try {
    await piperSpeak(text, {
      voice: voiceName,
      signal: controller.signal,
      onLog: (level, message) => rpc.log(level, `[piper] ${message}`),
    });
  } finally {
    if (currentTtsAbort === controller) {
      currentTtsAbort = undefined;
    }
  }
  rpc.event('tts.ended', {});
  return { status: 'ok' };
});

rpc.register('tts.cancel', async () => {
  if (currentTtsAbort) {
    currentTtsAbort.abort();
    currentTtsAbort = undefined;
    return { status: 'cancelled' };
  }
  return { status: 'nothing-to-cancel' };
});

rpc.register('stt.start', async (params) => {
  if (currentSttSession?.isRunning()) {
    throw new Error('stt: a session is already running; call stt.stop first');
  }
  const opts = (params ?? {}) as {
    model?: string;
    language?: string;
    stepMs?: number;
    lengthMs?: number;
    threads?: number;
    vadThreshold?: number;
    captureDevice?: number;
  };

  const session = new WhisperStreamSession((event) => {
    switch (event.type) {
      case 'started':
        rpc.event('stt.ready', {});
        break;
      case 'interim':
        rpc.event('stt.interim', { text: event.text });
        break;
      case 'log':
        rpc.log(event.level, `[whisper] ${event.message}`);
        break;
      case 'error':
        rpc.event('stt.error', { code: 'whisper-stream-error', message: event.message });
        break;
      case 'exit':
        rpc.event('stt.exit', { code: event.code, signal: event.signal });
        break;
    }
  });
  currentSttSession = session;
  try {
    session.start(opts);
  } catch (err) {
    currentSttSession = undefined;
    throw err;
  }
  return { status: 'started' };
});

rpc.register('stt.stop', async () => {
  const session = currentSttSession;
  if (!session) {
    return { status: 'not-running', text: '' };
  }
  const text = await session.stop();
  currentSttSession = undefined;
  return { status: 'stopped', text };
});

rpc.register('stt.cancel', async () => {
  const session = currentSttSession;
  if (!session) {
    return { status: 'not-running' };
  }
  await session.stop();
  currentSttSession = undefined;
  return { status: 'cancelled' };
});

rpc.log('info', `sidecar: started (pid=${process.pid}, node=${process.version})`);
