# claude-io

> Unofficial voice and vision I/O helpers for developers using Claude — speak to Claude, have Claude speak back, show Claude things.

> **Unaffiliated with Anthropic.** `claude-io` is an independent open-source project by an individual developer. It is not developed, endorsed, sponsored, or reviewed by Anthropic, PBC. *"Claude"* is a trademark of Anthropic, PBC, used here in a nominative sense to describe the Claude product this extension is designed to work alongside. No affiliation is implied. If you are from Anthropic and would like the project renamed, please open an issue.

## What it is

A VSCode extension that adds three I/O surfaces to your development environment:

- **Voice input** — press a hotkey, speak a prompt, the transcription is copied to your clipboard or inserted at your cursor
- **Voice output** — select text in an editor and have it read aloud by the OS speech synthesizer
- **Camera capture** — grab a frame from your webcam and get back a PNG path you can paste into Claude Code (or wherever)

The underlying model, conversation, and memory are unchanged — this extension just adds new *input and output channels* for developers who want to collaborate with Claude through voice and visual context rather than only typing.

## Why it exists

Text is a good medium for a lot of software engineering work, but some things land differently spoken, and some things are easier shown than described. *"See this error on my monitor"* and *"let me sketch the flow on a whiteboard"* are natural moves in human-to-human collaboration and currently friction-heavy when collaborating with an AI assistant. This project is a prototype to find out whether closing those gaps genuinely changes the feel of collaboration — or whether text is actually enough and the wish is imaginary.

## Get started

> **This is an early MVP (v0.0.1). You install it from source — there is no Marketplace listing yet.** See *Develop* below.

Once installed:

1. **`claude-io: Show Panel`** from the Command Palette opens the webview panel (beside your editor).
2. **`ctrl+alt+shift+v`** (mac: `cmd+alt+shift+v`) starts voice input. Speak your prompt.
3. **`ctrl+alt+shift+b`** (mac: `cmd+alt+shift+b`) stops voice input. Transcript is routed to your clipboard (default) or the active editor at cursor.
4. **Select text and press `ctrl+alt+shift+s`** to hear it spoken.
5. **`ctrl+alt+shift+c`** captures a webcam frame to a temp PNG and copies the path to your clipboard, ready to paste into Claude Code (as an image attachment) or wherever you want.

## Use

All commands are in the Command Palette under the `claude-io:` category:

| Command | Default keybinding | What it does |
|---|---|---|
| `claude-io: Show Panel` | — | Opens the webview |
| `claude-io: Start Voice Input` | `ctrl+alt+shift+v` | Begins recording via Web Speech API |
| `claude-io: Stop Voice Input` | `ctrl+alt+shift+b` | Stops recording and routes the accumulated transcript |
| `claude-io: Toggle Voice Input` | — | Start/stop toggle (not bound by default) |
| `claude-io: Speak Selection` | `ctrl+alt+shift+s` | Speaks the current selection (requires a selection) |
| `claude-io: Stop Speaking` | `ctrl+alt+shift+x` | Cancels in-progress speech |
| `claude-io: Capture Image from Camera` | `ctrl+alt+shift+c` | Grabs a webcam frame, saves PNG, copies path |
| `claude-io: Show Log` | — | Opens the output channel for diagnostics |

See **Settings → Extensions → claude-io** for provider, language, voice, rate, pitch, transcript destination, and camera options.

## Develop

```bash
git clone https://github.com/finnoybu/claude-io.git
cd claude-io
npm install
npm run build
```

Then open the folder in VSCode and press **F5** to launch an Extension Development Host with claude-io loaded. You can also run `npm run watch` in one terminal and F5 in VSCode for a tight feedback loop.

Type-check only (no emit): `npm run compile`.

## Planned components

- **`claude-io-vscode`** (this repo's `dist/extension.js`) — the VSCode extension. MVP status.
- **`claude-io-mobile`** — mobile app (iOS/Android, likely React Native) providing the same capabilities in a phone/tablet form factor. Future.
- **Possibly `claude-io-core`** — shared library for I/O handling if the VSCode and mobile implementations need to share non-trivial logic.

## Target domains

- `claude-io.dev` — IDE plugins (VSCode first, possibly JetBrains later)
- `claude-io.app` — mobile apps

Both are **aspirational / not yet registered**.

## Privacy

`claude-io` is a local-first tool. The maintainer operates no servers and collects no telemetry. However, the extension uses browser APIs that have their own data-flow behaviors you should understand before enabling them.

### Microphone (speech-to-text)

When voice input is enabled, `claude-io` calls the browser's [Web Speech API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API) (`SpeechRecognition` / `webkitSpeechRecognition`) to convert your speech to text.

**Important:** In Chromium-based runtimes (which includes VSCode's Electron shell), `SpeechRecognition` does **not** run locally. Chromium routes the microphone audio to **Google's cloud speech-recognition service** for transcription. This is a behavior of the underlying browser engine, not of `claude-io`, and the extension has no visibility into or control over that network call. Your spoken audio is processed on Google infrastructure under Google's terms.

The first time you start voice input in a given VSCode installation, `claude-io` displays a one-time notification describing this behavior. You can disable the web-speech STT path entirely by setting `claudeIo.allowNetworkSpeechRecognition` to `false` — voice input will then fail closed until a local provider is added.

A local speech-recognition provider (e.g., Whisper) is planned; until then, **do not use voice input for speech you are not comfortable sending to Google.**

### Camera (vision capture)

When you trigger a capture, `claude-io` uses `getUserMedia` to read a single frame from your webcam, writes it as a PNG to your operating system's temp directory (`<os-tmpdir>/claude-io/capture-<timestamp>-<random>.png`), and copies the file path to your system clipboard. The image never leaves your machine via `claude-io`. The camera is automatically disabled after a single-shot capture — the webcam LED will turn off.

**Note:** These PNG files are **not automatically deleted** by the extension. They remain in your temp directory until your operating system cleans it. If you capture frames you would prefer not to persist, delete them manually or clear the `claude-io` subfolder under your OS temp directory.

### Speaker (text-to-speech)

Text-to-speech uses the browser's `speechSynthesis` API, which calls the host operating system's built-in speech engine (SAPI on Windows, NSSpeechSynthesizer on macOS, speech-dispatcher on Linux). TTS runs locally. No audio is transmitted.

### Clipboard

`claude-io` writes to your system clipboard in two situations:

1. When a transcript is finalized and the destination is set to `clipboard` (the default) or when fallback occurs, the transcribed text is copied.
2. When a camera frame is captured, the absolute path of the saved PNG is copied.

Clipboard writes overwrite whatever was previously on the clipboard. If you want transcripts inserted at the cursor instead, set `claudeIo.transcript.destination` to `activeEditor`.

### What `claude-io` does not do

- No backend. The extension makes no network calls of its own.
- No telemetry. No analytics, no crash reporting, no usage tracking.
- No account, no login, no API keys stored by this extension.
- No data sent to Anthropic by this extension. The MVP does not integrate directly with Claude Code — transcripts and image paths are placed on the clipboard for you to paste where you want. A `claudeCode` transcript destination exists as a placeholder and currently falls back to clipboard.

### Regulatory posture

Because `claude-io` operates no servers and processes all data on your own device using APIs you consented to when you installed your operating system and browser runtime, the maintainer is not a data controller under GDPR or a business under CCPA for any data this extension handles. The Web Speech API cloud routing described above is performed by Google, under Google's terms, not by this project.

## Related

- [Anthropic — Claude](https://www.anthropic.com/claude) — the Anthropic product this extension is built to work alongside
- [Claude Code](https://docs.claude.com/claude-code) — Anthropic's official CLI and IDE integration for Claude
- [VSCode Extension API](https://code.visualstudio.com/api)
- [Web Speech API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API)
- [Whisper (OpenAI)](https://github.com/openai/whisper) — local STT candidate for a future provider
- [Piper TTS](https://github.com/rhasspy/piper) — local TTS candidate for a future provider

## Status

**Experimental. v0.0.1.** No Marketplace listing yet. No users guaranteed. If it proves itself, it may eventually land in a research project registry as a documented experiment; until then, treat it as a hacker's weekend project that happens to be public.

## License

Apache-2.0. See [LICENSE](./LICENSE).

Picked for the explicit patent grant (relevant in the voice/vision/AI space), permissive terms, and low contributor friction.

### Trademark notice

"Claude" and "Anthropic" are trademarks of Anthropic, PBC. `claude-io` is an independent project and its use of the name "Claude" is nominative — it refers to the Anthropic product this extension is designed to interoperate with, and does not imply sponsorship, endorsement, or affiliation. The Apache-2.0 license granted over this repository's source code does not grant any rights in Anthropic's marks.

"VSCode" and "Visual Studio Code" are trademarks of Microsoft Corporation.
