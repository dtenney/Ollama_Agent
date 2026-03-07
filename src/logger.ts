import * as vscode from 'vscode';

export const channel = vscode.window.createOutputChannel('Ollama Agent');

const ts = () => new Date().toISOString();

export const logInfo  = (m: string): void => channel.appendLine(`[INFO]  ${ts()}  ${m}`);
export const logWarn  = (m: string): void => channel.appendLine(`[WARN]  ${ts()}  ${m}`);
export const logError = (m: string): void => channel.appendLine(`[ERROR] ${ts()}  ${m}`);
