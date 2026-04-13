import * as vscode from 'vscode';

/**
 * Provider interfaces. Each capability (STT, TTS, vision) has a single
 * interface that MVP implementations and future replacements both conform to.
 *
 * Rule of thumb: commands depend on the interface, not the implementation.
 * To add a new provider (e.g., a Whisper STT backend), write a new class
 * that implements SttProvider and register it in extension.ts — no command
 * code changes required.
 */

export interface ProviderError {
  code: string;
  message: string;
}

export interface SttStartOptions {
  language: string;
  continuous: boolean;
}

export interface SttProvider {
  readonly id: string;
  isAvailable(): Promise<boolean>;
  start(opts: SttStartOptions): Promise<void>;
  stop(): Promise<void>;
  onInterim(cb: (text: string) => void): vscode.Disposable;
  onFinal(cb: (text: string) => void): vscode.Disposable;
  onError(cb: (err: ProviderError) => void): vscode.Disposable;
  onEnded(cb: () => void): vscode.Disposable;
}

export interface TtsSpeakOptions {
  voice?: string;
  rate?: number;
  pitch?: number;
}

export interface TtsProvider {
  readonly id: string;
  isAvailable(): Promise<boolean>;
  speak(text: string, opts?: TtsSpeakOptions): Promise<void>;
  cancel(): Promise<void>;
  onStart(cb: () => void): vscode.Disposable;
  onEnd(cb: () => void): vscode.Disposable;
  onError(cb: (err: ProviderError) => void): vscode.Disposable;
}

export interface CapturedFrame {
  dataUrl: string;
  width: number;
  height: number;
}

export interface VisionCaptureProvider {
  readonly id: string;
  isAvailable(): Promise<boolean>;
  enable(): Promise<void>;
  captureFrame(): Promise<CapturedFrame>;
  disable(): Promise<void>;
  onError(cb: (err: ProviderError) => void): vscode.Disposable;
}
