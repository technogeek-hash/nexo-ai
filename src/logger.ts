import * as vscode from 'vscode';

let _channel: vscode.OutputChannel | undefined;

export function getOutputChannel(): vscode.OutputChannel {
  if (!_channel) {
    _channel = vscode.window.createOutputChannel('NexoAgent', { log: true });
  }
  return _channel;
}

function ts(): string {
  return new Date().toISOString();
}

export function logInfo(msg: string, ...args: unknown[]): void {
  const ch = getOutputChannel();
  ch.appendLine(`[${ts()}] INFO  ${msg} ${args.length ? JSON.stringify(args) : ''}`);
}

export function logWarn(msg: string, ...args: unknown[]): void {
  const ch = getOutputChannel();
  ch.appendLine(`[${ts()}] WARN  ${msg} ${args.length ? JSON.stringify(args) : ''}`);
}

export function logError(msg: string, err?: unknown): void {
  const ch = getOutputChannel();
  const detail = err instanceof Error ? `${err.message}\n${err.stack}` : String(err ?? '');
  ch.appendLine(`[${ts()}] ERROR ${msg} ${detail}`);
}

export function logDebug(msg: string, ...args: unknown[]): void {
  const ch = getOutputChannel();
  ch.appendLine(`[${ts()}] DEBUG ${msg} ${args.length ? JSON.stringify(args) : ''}`);
}
