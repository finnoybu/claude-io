# claude-io

> Voice, vision, and speaker integrations that extend Claude with more natural collaboration channels — starting with IDE plugins and eventually mobile.

## What it is

`claude-io` is a project to give Claude sessions the ability to **hear, see, and speak** — voice input via microphone, voice output via speaker, and vision input via webcam — delivered as plugins and apps that wrap existing Claude interfaces (VSCode extension first, mobile second).

The goal is not a new Claude; it's a richer I/O surface for the Claude you already know. The underlying model, conversation, memory, and tools are unchanged. What changes is the cadence and the channels: collaboration with Claude today is shaped by the fact that text is the only medium. With voice, the interaction collapses to conversational timing. With vision, Claude can see what you're pointing at — a whiteboard, a screen, a sketch, a physical thing.

## Why it exists

Text is a good medium for a lot of software engineering work, but some things land differently spoken, and some things are easier shown than described. *"See this error on my monitor"* and *"let me sketch the flow on a whiteboard"* are natural moves in human-to-human collaboration, and they're currently friction-heavy when collaborating with Claude. This project is a prototype to find out whether closing those gaps genuinely changes the feel of the collaboration — or whether text is actually enough and the wish is imaginary.

The idea came out of a conversation on 2026-04-13 about what continuity, collaboration, and embodiment mean in human-AI work. It's speculative until it isn't.

## Get started

*Nothing yet — this repo is in the thinking/planning stage. Voice-loop prototype will land first.*

## Use

*TBD.*

## Develop

*TBD.*

## Planned components

- **`claude-io-vscode`** — VSCode extension wrapping mic (STT → chat input), speaker (chat output → TTS), and webcam capture (hotkey → vision-attached message).
- **`claude-io-mobile`** — mobile app (iOS/Android, likely React Native) providing the same capabilities in a phone/tablet form factor.
- **Possibly `claude-io-core`** — shared library for I/O handling if the VSCode and mobile implementations need to share non-trivial logic.

## Target domains

- `claude-io.dev` — IDE plugins (VSCode first, possibly JetBrains later)
- `claude-io.app` — mobile apps

Both are **aspirational / not yet registered**.

## Related

- [Anthropic — Claude API](https://docs.claude.com)
- [VSCode Extension API](https://code.visualstudio.com/api)
- [Whisper (OpenAI)](https://github.com/openai/whisper) — local STT candidate
- [Piper TTS](https://github.com/rhasspy/piper) — local TTS candidate
- [ElevenLabs](https://elevenlabs.io) — cloud TTS alternative

## Status

Experimental. No commitments, no timeline, no users. If it proves itself, it migrates toward `aegis-labs` as a documented experiment and eventually into `aegis-prime` (the future AEGIS Prime code repo) if it becomes infrastructure for how Prime operates.

## License

TBD — will pick before first public commit.
