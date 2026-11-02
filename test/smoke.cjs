// Loads the real bundled main.js against a fake Obsidian to catch start-up crashes.
const Module = require('module');
const path = require('path');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>');
for (const k of ['document', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'Node', 'Element', 'HTMLElement', 'DOMParser', 'Range', 'Selection']) {
  try { globalThis[k] = dom.window[k]; } catch {}
}
globalThis.window = Object.assign(globalThis, { addEventListener() {}, removeEventListener() {}, setInterval, clearInterval, innerWidth: 1000, innerHeight: 800, matchMedia: () => ({ matches: false }) });

const files = new Map([['a.md', { path: 'a.md', stat: { size: 5 }, text: 'hello' }]]);
class TAbstractFile {}
class TFile extends TAbstractFile {}
const mkFile = (p, text) => Object.assign(new TFile(), { path: p, stat: { size: text.length }, text });
const vfiles = new Map([['a.md', mkFile('a.md', 'hello')], ['b/c.md', mkFile('b/c.md', 'see')]]);
const store = {};
const el = () => { const e = { addEventListener() {}, setText(t) { e.t = t; }, getText() { return e.t; }, setAttr() {}, addClass() {}, empty() {}, createEl() { return el(); } }; return e; };
let statusEl;
const mock = {
  Plugin: class {
    constructor() {
      this.manifest = { id: 'live-room-sync', dir: '.obsidian/plugins/live-room-sync' };
      this.layoutCbs = [];
      const adapter = { exists: async (p) => vfiles.has(p) || p in store, readBinary: async (p) => store[p], writeBinary: async (p, d) => { store[p] = d; }, read: async (p) => store[p], write: async (p, d) => { store[p] = d; }, mkdir: async () => {} };
      this.app = {
        vault: {
          configDir: '.obsidian', adapter,
          getFiles: () => [...vfiles.values()],
          getAbstractFileByPath: (p) => vfiles.get(p) ?? null,
          read: async (f) => f.text, readBinary: async (f) => new TextEncoder().encode(f.text).buffer,
          modify: async (f, d) => { f.text = d; }, create: async (p, d) => { vfiles.set(p, mkFile(p, d)); },
          createFolder: async () => {}, on: (n, cb) => ({ n, cb }), offref: () => {},
        },
        workspace: { on: (n, cb) => ({ n, cb }), onLayoutReady: (cb) => cb(), getLeavesOfType: () => [], getActiveFile: () => null, getActiveViewOfType: () => null, getRightLeaf: () => null },
        fileManager: { trashFile: async () => {} },
      };
    }
    async loadData() { return this.saved ?? { roomCode: 'ABCDE-FGHJK-LMNPQ-RSTUV', accepted: true, network: 'nostr', people: {} }; }
    async saveData(d) { this.saved = d; }
    registerEditorExtension() {} addStatusBarItem() { statusEl = el(); return statusEl; }
    registerInterval() {} registerEvent() {} registerView() {} addRibbonIcon() {} registerObsidianProtocolHandler() {} addCommand(c) { (this.cmds ||= []).push(c.id); } addSettingTab() {}
  },
  Notice: class { constructor(m) { console.log('NOTICE', m); } },
  Modal: class {}, ItemView: class {}, setIcon() {}, PluginSettingTab: class {}, Setting: class {}, MarkdownView: class {}, TFile, TAbstractFile,
  Platform: { isMacOS: false, isWin: true, isIosApp: false, isAndroidApp: false },
  normalizePath: (p) => p.replace(/\\/g, '/'),
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'obsidian' ? mock : origLoad.call(this, req, ...rest); };
const Plugin = require(path.resolve(__dirname, '../main.js')).default;
(async () => {
  const p = new Plugin();
  await p.onload();
  console.log('commands:', p.cmds.join(','));
  console.log('identity made:', !!(p.settings.identity && p.settings.identity.id && p.settings.identity.priv));
  console.log('members at start:', JSON.stringify(p.members().map((m) => m.kind)));
  await new Promise((r) => setTimeout(r, 2500));
  console.log('status:', statusEl.t);
  console.log('log:', p.logLines.join(' | '));
  await p.onunload();
  console.log('state file written:', Object.keys(store).join(','));
  console.log('status after stop:', statusEl.t);
  process.exit(0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
