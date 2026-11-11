// Minimal stand-in for the "vscode" module in unit tests. Extend it in your own test file with vi.mock if you need more.
export class EventEmitter<T> {
  private l: ((e: T) => void)[] = [];
  event = (fn: (e: T) => void) => { this.l.push(fn); return { dispose: () => { this.l = this.l.filter((x) => x !== fn); } }; };
  fire(e: T) { this.l.forEach((fn) => fn(e)); }
  dispose() { this.l = []; }
}
export const Uri = { file: (p: string) => ({ fsPath: p, path: p, scheme: "file" }), parse: (s: string) => ({ toString: () => s }),
  joinPath: (u: any, ...p: string[]) => ({ fsPath: [u.fsPath, ...p].join("/") }) };
export const window = { showInformationMessage: async () => undefined, showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined, showInputBox: async () => undefined, showQuickPick: async () => undefined,
  createOutputChannel: () => ({ appendLine() {}, dispose() {} }) };
export class RelativePattern { constructor(public base: unknown, public pattern: string) {} }
const noopEvent = () => ({ dispose() {} });
export const workspace = { getConfiguration: () => ({ get: (_k: string, d?: unknown) => d }), workspaceFolders: [],
  onDidChangeConfiguration: noopEvent,
  createFileSystemWatcher: () => ({ onDidChange: noopEvent, onDidCreate: noopEvent, onDidDelete: noopEvent, dispose() {} }) };
export const env = { openExternal: async () => true };
export const commands = { registerCommand: () => ({ dispose() {} }), executeCommand: async () => undefined };
export const authentication = { getSession: async () => undefined };
export enum ViewColumn { Active = -1, One = 1 }
