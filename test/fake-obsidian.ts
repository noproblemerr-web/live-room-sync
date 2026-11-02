// A small stand-in for the parts of Obsidian the plugin uses, so the whole plugin
// (not just the sync engine) can be tested with two "devices" in one process.

(globalThis as Record<string, unknown>).window ??= globalThis; // the plugin calls window.setInterval

export const notices: string[] = [];

export class TAbstractFile {
  path = '';
}
export class TFile extends TAbstractFile {
  stat = { size: 0 };
  basename: string;
  extension: string;
  constructor(path: string, size = 0) {
    super();
    this.path = path;
    this.stat.size = size;
    const name = path.slice(path.lastIndexOf('/') + 1);
    const dot = name.lastIndexOf('.');
    this.basename = dot > 0 ? name.slice(0, dot) : name;
    this.extension = dot > 0 ? name.slice(dot + 1) : '';
  }
}

export class Notice {
  constructor(message: string) {
    notices.push(String(message));
  }
}
export class Modal {
  contentEl: unknown = {};
  constructor(public app: unknown) {}
  open() {}
  close() {}
}
export class ItemView {
  contentEl: unknown = {};
  constructor(public leaf: unknown) {}
}
export class PluginSettingTab {
  containerEl: unknown = {};
  constructor(public app: unknown, public plugin: unknown) {}
}
export class Setting {}
export class MarkdownView {}
export class WorkspaceLeaf {}
export const Platform = { isMacOS: true, isWin: false, isIosApp: false, isAndroidApp: false, isMobile: false };
export const normalizePath = (p: string) => p.replace(/\\/g, '/').replace(/\/+/g, '/');
export const setIcon = () => {};

type Handler = (...a: any[]) => void;

export class FakeVault {
  configDir = '.obsidian';
  files = new Map<string, string | ArrayBuffer>();
  private handlers = new Map<string, Handler[]>();
  private objs = new Map<string, TFile>();

  adapter = {
    exists: async (p: string) => this.files.has(p) || this.extra.has(p) || [...this.extra.keys()].some((k) => k.startsWith(p + '/')),
    read: async (p: string) => this.extra.get(p) as string,
    write: async (p: string, d: string) => void this.extra.set(p, d),
    readBinary: async (p: string) => this.extra.get(p) as ArrayBuffer,
    writeBinary: async (p: string, d: ArrayBuffer) => void this.extra.set(p, d),
    mkdir: async (_p: string) => {},
  };
  /** things in the plugin folder, which the plugin never syncs */
  extra = new Map<string, string | ArrayBuffer>();

  private obj(path: string): TFile {
    let o = this.objs.get(path);
    if (!o) this.objs.set(path, (o = new TFile(path)));
    const v = this.files.get(path);
    o.stat.size = typeof v === 'string' ? v.length : v ? v.byteLength : 0;
    return o;
  }
  private fire(name: string, ...args: any[]) {
    setTimeout(() => (this.handlers.get(name) ?? []).forEach((h) => h(...args)), 3);
  }

  on(name: string, cb: Handler) {
    const list = this.handlers.get(name) ?? [];
    list.push(cb);
    this.handlers.set(name, list);
    return { name, cb };
  }
  offref(ref: { name: string; cb: Handler }) {
    this.handlers.set(ref.name, (this.handlers.get(ref.name) ?? []).filter((h) => h !== ref.cb));
  }
  getFiles = () => [...this.files.keys()].map((p) => this.obj(p));
  getAbstractFileByPath = (p: string) => (this.files.has(p) ? this.obj(p) : null);
  read = async (f: TFile) => this.files.get(f.path) as string;
  readBinary = async (f: TFile) => {
    const v = this.files.get(f.path);
    return typeof v === 'string' ? (new TextEncoder().encode(v).buffer as ArrayBuffer) : (v as ArrayBuffer);
  };
  modify = async (f: TFile, d: string) => {
    this.files.set(f.path, d);
    this.fire('modify', this.obj(f.path));
  };
  modifyBinary = async (f: TFile, d: ArrayBuffer) => {
    this.files.set(f.path, d);
    this.fire('modify', this.obj(f.path));
  };
  create = async (p: string, d: string) => {
    this.files.set(p, d);
    this.fire('create', this.obj(p));
  };
  createBinary = async (p: string, d: ArrayBuffer) => {
    this.files.set(p, d);
    this.fire('create', this.obj(p));
  };
  createFolder = async () => {};
  trash(path: string) {
    const o = this.obj(path);
    this.files.delete(path);
    this.fire('delete', o);
  }
  /** what a person does in the editor */
  userWrite(path: string, text: string) {
    const existed = this.files.has(path);
    this.files.set(path, text);
    this.fire(existed ? 'modify' : 'create', this.obj(path));
  }
}

export class FakeApp {
  vault = new FakeVault();
  activeFile: TFile | null = null;
  opened: string[] = [];
  workspace = {
    on: (name: string, cb: Handler) => ({ name, cb }),
    onLayoutReady: (cb: () => void) => cb(),
    getLeavesOfType: () => [] as unknown[],
    getActiveFile: () => this.activeFile,
    getActiveViewOfType: () => null,
    getRightLeaf: () => ({ setViewState: async () => {} }),
    revealLeaf: async () => {},
    getLeaf: () => ({ openFile: async (f: TFile) => void this.opened.push(f.path) }),
  };
  fileManager = { trashFile: async (f: TFile) => this.vault.trash(f.path) };
}

export class Plugin {
  manifest = { id: 'live-room-sync', dir: '.obsidian/plugins/live-room-sync' };
  commands: string[] = [];
  statusItem = { t: '', setText(x: string) { this.t = x; }, getText() { return this.t; }, setAttr() {}, addClass() {}, addEventListener() {} };
  private data: unknown = null;
  constructor(public app: FakeApp) {}
  async loadData() {
    return this.data;
  }
  async saveData(d: unknown) {
    this.data = JSON.parse(JSON.stringify(d));
  }
  registerEditorExtension() {}
  registerView() {}
  registerInterval() {}
  registerEvent() {}
  registerObsidianProtocolHandler() {}
  addRibbonIcon() {}
  addSettingTab() {}
  addStatusBarItem() {
    return this.statusItem;
  }
  addCommand(c: { id: string }) {
    this.commands.push(c.id);
  }
}
