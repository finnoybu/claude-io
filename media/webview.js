/*
 * claude-io webview-side script.
 *
 * Runs inside the Chromium-based VSCode webview. Handles all browser-only
 * APIs: SpeechRecognition, speechSynthesis, getUserMedia, canvas frame
 * extraction.
 *
 * Protocol mirrors src/webview/messages.ts. Keep in sync by convention.
 */

(function () {
  'use strict';

  // eslint-disable-next-line no-undef
  const vscode = acquireVsCodeApi();

  // ===== state =====
  /** @type {any} */
  let recognition = null;
  let shouldBeRecognizing = false;
  let currentUtterance = null;
  /** @type {MediaStream | null} */
  let cameraStream = null;
  /** @type {boolean} */
  let voicesReady = false;

  // BCP-47 language tag — letters, digits, and hyphens only
  const LANG_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
  const MAX_LOG_LENGTH = 2048;

  // ===== DOM =====
  const statusEl = document.getElementById('status');
  const aiPresenceEl = document.getElementById('ai-presence');
  const aiCaptionEl = document.getElementById('ai-caption');
  const sttInterimEl = document.getElementById('stt-interim');
  const sttFinalEl = document.getElementById('stt-final');
  const ttsCurrentEl = document.getElementById('tts-current');
  const videoEl = /** @type {HTMLVideoElement} */ (document.getElementById('camera-preview'));
  const canvasEl = /** @type {HTMLCanvasElement} */ (document.getElementById('camera-canvas'));
  const thumbEl = /** @type {HTMLImageElement} */ (document.getElementById('camera-thumb'));

  // ===== utility =====
  function postMessage(msg) {
    vscode.postMessage(msg);
  }

  function log(level, message) {
    const safe = String(message).slice(0, MAX_LOG_LENGTH);
    postMessage({ type: 'log', payload: { level, message: safe } });
  }

  function setStatus(text) {
    if (statusEl) {
      statusEl.textContent = text;
    }
  }

  function setPresenceState(state, utterance) {
    if (!aiPresenceEl) return;
    aiPresenceEl.className = 'ai-presence ai-presence-' + state;
    if (utterance !== undefined && aiCaptionEl) {
      aiCaptionEl.textContent = utterance;
    } else if (state === 'idle' && aiCaptionEl) {
      aiCaptionEl.textContent = '';
    }
  }

  function setMode(mode) {
    document.body.setAttribute('data-mode', mode);
    switch (mode) {
      case 'idle':
        setStatus('Idle');
        break;
      case 'recording':
        setStatus('Listening…');
        break;
      case 'speaking':
        setStatus('Speaking…');
        break;
      case 'camera':
        setStatus('Camera active');
        break;
      default:
        setStatus(String(mode));
    }
  }

  // ===== capabilities =====
  function detectCapabilities() {
    const hasSpeechRecognition =
      typeof window !== 'undefined' &&
      (typeof window.SpeechRecognition !== 'undefined' ||
        typeof window.webkitSpeechRecognition !== 'undefined');
    const hasSpeechSynthesis = typeof window !== 'undefined' && typeof window.speechSynthesis !== 'undefined';
    const hasGetUserMedia =
      typeof navigator !== 'undefined' &&
      typeof navigator.mediaDevices !== 'undefined' &&
      typeof navigator.mediaDevices.getUserMedia === 'function';

    return {
      speechRecognitionAvailable: hasSpeechRecognition,
      speechSynthesisAvailable: hasSpeechSynthesis,
      getUserMediaAvailable: hasGetUserMedia,
    };
  }

  // ===== STT =====
  function startStt(payload) {
    const Ctor =
      window.SpeechRecognition ||
      window.webkitSpeechRecognition;
    if (!Ctor) {
      postMessage({
        type: 'stt.error',
        payload: {
          code: 'unavailable',
          message: 'SpeechRecognition is not available in this runtime',
        },
      });
      return;
    }
    try {
      recognition = new Ctor();
      const rawLang = typeof payload.language === 'string' ? payload.language : 'en-US';
      const lang = LANG_RE.test(rawLang) ? rawLang : 'en-US';
      if (lang !== rawLang) {
        log('warn', 'invalid language code "' + rawLang + '", falling back to en-US');
      }
      recognition.lang = lang;
      recognition.interimResults = true;
      recognition.continuous = !!payload.continuous;
      recognition.maxAlternatives = 1;

      recognition.onresult = (event) => {
        let interim = '';
        let final = '';
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const result = event.results[i];
          const transcript = result[0].transcript;
          if (result.isFinal) {
            final += transcript;
          } else {
            interim += transcript;
          }
        }
        if (interim) {
          sttInterimEl.textContent = interim;
          postMessage({ type: 'stt.interim', payload: { text: interim } });
        }
        if (final) {
          sttFinalEl.textContent = final;
          postMessage({ type: 'stt.final', payload: { text: final } });
        }
      };

      recognition.onerror = (event) => {
        const code = event.error || 'unknown';
        const message = event.message || code;
        log('error', 'SpeechRecognition error: ' + code + ' ' + message);
        shouldBeRecognizing = false;
        postMessage({ type: 'stt.error', payload: { code, message } });
        // Also signal ended so the host transcript accumulator can flush.
        postMessage({ type: 'stt.ended' });
      };

      recognition.onend = () => {
        if (shouldBeRecognizing) {
          // Chromium fires onend after ~60s of silence even in continuous
          // mode. Restart if we're supposed to still be recognizing.
          try {
            recognition.start();
            log('info', 'SpeechRecognition restarted after silence timeout');
          } catch (err) {
            log('error', 'SpeechRecognition restart failed: ' + String(err));
            shouldBeRecognizing = false;
            postMessage({ type: 'stt.ended' });
          }
        } else {
          postMessage({ type: 'stt.ended' });
        }
      };

      shouldBeRecognizing = true;
      recognition.start();
      log('info', 'SpeechRecognition started');
    } catch (err) {
      log('error', 'SpeechRecognition start failed: ' + String(err));
      postMessage({
        type: 'stt.error',
        payload: { code: 'start-failed', message: String(err) },
      });
    }
  }

  function stopStt() {
    shouldBeRecognizing = false;
    if (recognition) {
      try {
        recognition.stop();
      } catch (err) {
        log('warn', 'SpeechRecognition.stop error: ' + String(err));
      }
      recognition = null;
    }
  }

  // ===== TTS =====
  /**
   * Wait for speechSynthesis voices to be available. In Chromium,
   * getVoices() returns an empty array on first call until the
   * `voiceschanged` event fires. This is a well-known quirk.
   */
  function waitForVoices(timeoutMs) {
    return new Promise((resolve) => {
      if (voicesReady) {
        resolve(window.speechSynthesis.getVoices());
        return;
      }
      const voices = window.speechSynthesis.getVoices();
      if (voices.length > 0) {
        voicesReady = true;
        resolve(voices);
        return;
      }
      const timer = setTimeout(() => {
        voicesReady = true;
        resolve(window.speechSynthesis.getVoices());
      }, timeoutMs);
      window.speechSynthesis.addEventListener(
        'voiceschanged',
        function onVoicesChanged() {
          clearTimeout(timer);
          voicesReady = true;
          window.speechSynthesis.removeEventListener('voiceschanged', onVoicesChanged);
          resolve(window.speechSynthesis.getVoices());
        },
        { once: true },
      );
    });
  }

  async function speak(payload) {
    if (!window.speechSynthesis) {
      postMessage({
        type: 'tts.error',
        payload: {
          code: 'unavailable',
          message: 'speechSynthesis is not available',
        },
      });
      return;
    }
    try {
      // Cancel anything currently queued/speaking.
      window.speechSynthesis.cancel();

      const u = new SpeechSynthesisUtterance(payload.text);
      if (typeof payload.rate === 'number') u.rate = payload.rate;
      if (typeof payload.pitch === 'number') u.pitch = payload.pitch;
      if (payload.voice) {
        const voices = await waitForVoices(500);
        const match = voices.find((v) => v.name === payload.voice);
        if (match) {
          u.voice = match;
        } else {
          log('warn', 'Requested TTS voice not found: ' + payload.voice);
        }
      }

      u.onstart = () => {
        ttsCurrentEl.textContent = payload.text;
        postMessage({ type: 'tts.started' });
      };
      u.onend = () => {
        currentUtterance = null;
        postMessage({ type: 'tts.ended' });
      };
      u.onerror = (event) => {
        currentUtterance = null;
        log('error', 'speechSynthesis error: ' + (event.error || 'unknown'));
        postMessage({
          type: 'tts.error',
          payload: {
            code: event.error || 'unknown',
            message: 'speechSynthesis error',
          },
        });
      };

      currentUtterance = u;
      window.speechSynthesis.speak(u);
      log('info', 'speechSynthesis speak queued (' + payload.text.length + ' chars)');
    } catch (err) {
      log('error', 'speechSynthesis speak failed: ' + String(err));
      postMessage({
        type: 'tts.error',
        payload: { code: 'speak-failed', message: String(err) },
      });
    }
  }

  function cancelTts() {
    if (window.speechSynthesis) {
      try {
        window.speechSynthesis.cancel();
      } catch (err) {
        log('warn', 'speechSynthesis.cancel error: ' + String(err));
      }
    }
    currentUtterance = null;
  }

  // ===== Camera =====
  async function enableCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      postMessage({
        type: 'camera.error',
        payload: {
          code: 'unavailable',
          message: 'getUserMedia is not available',
        },
      });
      return;
    }
    if (cameraStream) {
      postMessage({ type: 'camera.enabled' });
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      cameraStream = stream;
      videoEl.srcObject = stream;
      await new Promise((resolve) => {
        if (videoEl.readyState >= 2) {
          resolve();
        } else {
          videoEl.onloadedmetadata = () => resolve();
        }
      });
      postMessage({ type: 'camera.enabled' });
      log('info', 'camera enabled (' + videoEl.videoWidth + 'x' + videoEl.videoHeight + ')');
    } catch (err) {
      const code = err && err.name ? err.name : 'unknown';
      const message = err && err.message ? err.message : String(err);
      log('error', 'getUserMedia failed: ' + code + ' ' + message);
      postMessage({ type: 'camera.error', payload: { code, message } });
    }
  }

  function captureFrame() {
    if (!cameraStream || !videoEl.videoWidth || !videoEl.videoHeight) {
      postMessage({
        type: 'camera.error',
        payload: {
          code: 'not-enabled',
          message: 'camera is not enabled',
        },
      });
      return;
    }
    try {
      canvasEl.width = videoEl.videoWidth;
      canvasEl.height = videoEl.videoHeight;
      const ctx = canvasEl.getContext('2d');
      if (!ctx) {
        throw new Error('canvas 2d context unavailable');
      }
      ctx.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);
      const dataUrl = canvasEl.toDataURL('image/png');
      thumbEl.src = dataUrl;
      postMessage({
        type: 'camera.frame',
        payload: {
          dataUrl,
          width: canvasEl.width,
          height: canvasEl.height,
        },
      });
      log('info', 'camera frame captured (' + canvasEl.width + 'x' + canvasEl.height + ')');
    } catch (err) {
      log('error', 'captureFrame failed: ' + String(err));
      postMessage({
        type: 'camera.error',
        payload: { code: 'capture-failed', message: String(err) },
      });
    }
  }

  function disableCamera() {
    if (cameraStream) {
      try {
        cameraStream.getTracks().forEach((track) => track.stop());
      } catch (err) {
        log('warn', 'camera track stop error: ' + String(err));
      }
      cameraStream = null;
    }
    if (videoEl) {
      videoEl.srcObject = null;
    }
    postMessage({ type: 'camera.disabled' });
  }

  // ===== message dispatch =====
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'stt.start':
        startStt(msg.payload || {});
        break;
      case 'stt.stop':
        stopStt();
        break;
      case 'tts.speak':
        void speak(msg.payload || {});
        break;
      case 'tts.cancel':
        cancelTts();
        break;
      case 'camera.enable':
        void enableCamera();
        break;
      case 'camera.capture':
        captureFrame();
        break;
      case 'camera.disable':
        disableCamera();
        break;
      case 'ui.setMode':
        setMode(msg.payload.mode);
        break;
      case 'ai.setState':
        setPresenceState(msg.payload.state, msg.payload.utterance);
        break;
      default:
        log('warn', 'unknown host message: ' + msg.type);
    }
  });

  // ===== defensive cleanup =====
  window.addEventListener('beforeunload', () => {
    try {
      stopStt();
    } catch (_) {
      // ignore
    }
    try {
      cancelTts();
    } catch (_) {
      // ignore
    }
    try {
      disableCamera();
    } catch (_) {
      // ignore
    }
  });

  // ===== boot =====
  document.addEventListener('DOMContentLoaded', () => {
    const capabilities = detectCapabilities();
    setPresenceState('idle');
    setMode('idle');
    // Prime the voices list so subsequent `speak` calls can find the
    // user's configured voice on first try.
    if (capabilities.speechSynthesisAvailable) {
      try {
        const initialVoices = window.speechSynthesis.getVoices();
        if (initialVoices.length > 0) {
          voicesReady = true;
        } else {
          window.speechSynthesis.addEventListener(
            'voiceschanged',
            function onInitialVoices() {
              voicesReady = true;
              window.speechSynthesis.removeEventListener('voiceschanged', onInitialVoices);
            },
            { once: true },
          );
        }
      } catch (err) {
        log('warn', 'voices priming failed: ' + String(err));
      }
    }
    postMessage({ type: 'ready', payload: capabilities });
    log('info', 'webview ready: ' + JSON.stringify(capabilities));
  });
})();
