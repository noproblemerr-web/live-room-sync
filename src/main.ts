import {
  App,
  EventRef,
  MarkdownView,
  Modal,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath,
} from 'obsidian';
import type { EditorView } from '@codemirror/view';
import { selfId } from '@trystero-p2p/nostr';
import { SyncEngine, type Persist, type VaultAdapter } from './engine';
import { RoomProvider } from './provider';
import { TrysteroTransport, type NetworkKind } from './transport-trystero';
import { CmBinder } from './cm-binder';
import { generateRoomCode, normalizeRoomCode, sha256Hex, toArrayBuffer, isTextPath } from './util';

interface Settings {
  roomCode: string;
  deviceName: string;
  color: string;
  liveTyping: boolean;
  syncAttachments: boolean;
  maxAttachmentMB: number;
  excludedFolders: string;
  network: NetworkKind;
  turnJson: string;
  accepted: boolean; // user confirmed they made a backup
  paused: boolean;
  metaRoom: string;
  known: Record<string, { h: string; s: number }>;
}

const COLORS = ['#e5484d', '#f76b15', '#d6a100', '#30a46c', '#0091ff', '#8e4ec6', '#d6409f', '#12a594'];

const defaultName = () =>
  Platform.isMacOS ? 'Mac' : Platform.isWin ? 'Windows PC' : Platform.isIosApp ? 'iPhone' : Platform.isAndroidApp ? 'Android' : 'Device';

const DEFAULTS = (): Settings => ({
  roomCode: '',
  deviceName: defaultName(),
  color: COLORS[Math.floor(Math.random() * COLORS.length)],
  liveTyping: true,
  syncAttachments: true,
  maxAttachmentMB: 25,
  excludedFolders: '',
  network: 'nostr',
  turnJson: '',
  accepted: false,
  paused: false,
  metaRoom: '',
  known: {},
});

export default class LiveRoomSync extends Plugin {
  settings: Settings = DEFAULTS();

  private engine: SyncEngine | null = null;
  private provider: RoomProvider | null = null;
  private transport: TrysteroTransport | null = null;
  private binder = new CmBinder(this.binderHost());
  private eventRefs: EventRef[] = [];
  private statusEl: HTMLElement | null = null;
  private starting = false;
  private lastError = '';
  private logLines: string[] = [];
  private metaTimer: ReturnType<typeof setTimeout> | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.registerEditorExtension(this.binder.extension);

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass('live-room-status');
    this.registerInterval(window.setInterval(() => this.heartbeat(), 1000));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.heartbeat()));
    this.registerEvent(this.app.workspace.on('layout-change', () => this.heartbeat()));
    this.registerEvent(this.app.workspace.on('file-open', () => this.heartbeat()));

    this.addCommand({
      id: 'copy-room-code',
      name: 'Copy room code',
      callback: () => this.copyCode(),
    });
    this.addCommand({
      id: 'reconnect',
      name: 'Reconnect',
      callback: () => void this.restart(),
    });
    this.addCommand({
      id: 'rescan',
      name: 'Check all files now',
      callback: () => void this.engine?.rescan().then(() => new Notice('Live Room Sync: checked all files.')),
    });
    this.addCommand({
      id: 'toggle-pause',
      name: 'Pause or resume syncing',
      callback: async () => {
        this.settings.paused = !this.settings.paused;
        await this.saveSettings();
        await this.restart();
        new Notice(this.settings.paused ? 'Live Room Sync: paused.' : 'Live Room Sync: resumed.');
      },
    });
    this.addCommand({
      id: 'copy-debug-log',
      name: 'Copy debug log',
      callback: async () => {
        await navigator.clipboard.writeText(this.logLines.join('\n') || '(empty)');
        new Notice('Live Room Sync: log copied.');
      },
    });

    this.addSettingTab(new LiveRoomSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => void this.startSync());
  }

  async onunload(): Promise<void> {
    await this.stopSync();
  }

  // ------------------------------------------------------------------ settings

  async loadSettings(): Promise<void> {
    this.settings = Object.assign(DEFAULTS(), await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private queueMetaSave(): void {
    if (this.metaTimer) clearTimeout(this.metaTimer);
    this.metaTimer = setTimeout(() => {
      this.metaTimer = null;
      if (!this.engine) return;
      this.settings.known = this.engine.exportMeta().known ?? {};
      void this.saveSettings();
    }, 2000);
  }

  // ------------------------------------------------------------------ run / stop

  async restart(): Promise<void> {
    await this.stopSync();
    await this.startSync();
  }

  private async startSync(): Promise<void> {
    if (this.engine || this.starting) return;
    if (this.settings.paused) return this.renderStatus();
    const code = normalizeRoomCode(this.settings.roomCode);
    if (!code) return this.renderStatus();
    if (!this.settings.accepted) {
      new FirstRunModal(this.app, async () => {
        this.settings.accepted = true;
        await this.saveSettings();
        await this.startSync();
      }).open();
      return;
    }

    this.starting = true;
    this.lastError = '';
    try {
      const roomHash = (await sha256Hex(new TextEncoder().encode('live-room-sync/state/' + code))).slice(0, 12);
      if (this.settings.metaRoom !== roomHash) {
        this.settings.metaRoom = roomHash;
        this.settings.known = {};
      }
      const engine = new SyncEngine({
        vault: this.makeVaultAdapter(),
        persist: this.makePersist(roomHash),
        deviceName: this.settings.deviceName || defaultName(),
        configDir: this.app.vault.configDir,
        excluded: this.settings.excludedFolders.split('\n'),
        syncAttachments: this.settings.syncAttachments,
        maxAttachmentBytes: Math.max(1, this.settings.maxAttachmentMB) * 1024 * 1024,
        log: (level, msg) => this.log(level, msg),
        notify: (msg) => new Notice('Live Room Sync: ' + msg, 10000),
      });
      engine.importMeta({ known: this.settings.known });
      engine.onMetaChange = () => this.queueMetaSave();
      this.setLocalUser(engine);
      await engine.start();
      this.engine = engine;

      this.eventRefs = [
        this.app.vault.on('create', (f) => f instanceof TFile && engine.onVaultCreate(f.path)),
        this.app.vault.on('modify', (f) => f instanceof TFile && engine.onVaultModify(f.path)),
        this.app.vault.on('delete', (f) => f instanceof TFile && engine.onVaultDelete(f.path)),
        this.app.vault.on('rename', (f, old) => f instanceof TFile && engine.onVaultRename(f.path, old)),
      ];

      const transport = await TrysteroTransport.create({
        code,
        network: this.settings.network,
        turn: this.parseTurn(),
        selfId,
      });
      this.transport = transport;
      const provider = new RoomProvider(engine.doc, engine.awareness, transport);
      this.provider = provider;
      engine.setNet({
        peers: () => transport.peers(),
        sendWant: (p, h) => provider.sendWant(p, h),
        sendBlob: (p, h, d) => provider.sendBlob(p, h, d),
      });
      provider.onSynced = () => {
        this.log('info', 'another device answered');
        engine.notifySynced();
        this.renderStatus();
      };
      provider.onPeersChanged = () => {
        engine.onPeersChanged();
        this.renderStatus();
      };
      provider.onWant = (h, from) => void engine.handleWant(h, from);
      provider.onBlob = (h, d) => void engine.receiveBlob(h, d);
      this.log('info', `joined room via ${this.settings.network}`);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.log('error', 'start failed: ' + this.lastError);
      await this.stopSync();
    } finally {
      this.starting = false;
      this.renderStatus();
    }
  }

  private async stopSync(): Promise<void> {
    this.binder.unbindAll();
    for (const r of this.eventRefs) this.app.vault.offref(r);
    this.eventRefs = [];
    const provider = this.provider;
    const engine = this.engine;
    this.provider = null;
    this.transport = null;
    this.engine = null;
    try {
      await provider?.destroy();
    } catch (err) {
      this.log('warn', 'leave failed: ' + String(err));
    }
    if (engine) {
      this.settings.known = engine.exportMeta().known ?? {};
      await engine.stop();
      await this.saveSettings();
    }
    this.renderStatus();
  }

  private parseTurn() {
    const raw = this.settings.turnJson.trim();
    if (!raw) return undefined;
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v : [v];
    } catch {
      new Notice('Live Room Sync: the TURN server text is not valid JSON, ignoring it.');
      return undefined;
    }
  }

  private setLocalUser(engine: SyncEngine): void {
    engine.awareness.setLocalStateField('user', {
      name: this.settings.deviceName || defaultName(),
      color: this.settings.color,
      colorLight: this.settings.color + '33',
    });
  }

  updateUser(): void {
    if (this.engine) this.setLocalUser(this.engine);
  }

  // ------------------------------------------------------------------ editors

  private binderHost() {
    const plugin = this;
    return {
      get awareness() {
        return plugin.engine!.awareness;
      },
      getText: (p: string) => this.engine?.getText(p) ?? null,
      setBound: (p: string, b: boolean) => this.engine?.setBound(p, b),
      reconcile: (p: string) => void this.engine?.reconcileNow(p),
      log: (m: string) => this.log('info', m),
    };
  }

  private heartbeat(): void {
    this.renderStatus();
    const engine = this.engine;
    if (!engine || !this.settings.liveTyping || !engine.isReady()) {
      this.binder.unbindAll();
      return;
    }
    const open: { view: EditorView; path: string }[] = [];
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const v = leaf.view;
      if (!(v instanceof MarkdownView) || !v.file) continue;
      if (v.getMode() !== 'source') continue;
      const path = v.file.path;
      if (!isTextPath(path) || !engine.shouldSync(path)) continue;
      const cm = (v.editor as unknown as { cm?: EditorView }).cm;
      if (cm) open.push({ view: cm, path });
    }
    this.binder.tick(open);
  }

  // ------------------------------------------------------------------ status / log

  private renderStatus(): void {
    const el = this.statusEl;
    if (!el) return;
    let text: string;
    let title: string;
    const peers = this.transport?.peers().length ?? 0;
    if (this.settings.paused) [text, title] = ['Live: paused', 'Syncing is paused'];
    else if (!normalizeRoomCode(this.settings.roomCode)) [text, title] = ['Live: no room', 'Open the plugin settings and create or paste a room code'];
    else if (this.lastError) [text, title] = ['Live: error', this.lastError];
    else if (!this.engine || !this.transport) {
      [text, title] = this.starting ? ['Live: starting', 'Starting'] : ['Live: off', 'Not connected. Use the command "Live Room Sync: Reconnect".'];
    }
    else if (peers === 0) [text, title] = ['Live: alone', 'Waiting for another device to open Obsidian with the same room code'];
    else {
      const s = this.engine.status();
      const live = this.binder.count();
      text = `Live: ${peers + 1} here${s.pending ? ' · syncing' : ''}`;
      title = `${peers + 1} devices in the room, ${s.files} files shared${live ? `, ${live} open note(s) typing live` : ''}`;
    }
    if (el.getText() !== text) el.setText(text);
    el.setAttr('title', title);
  }

  private log(level: string, msg: string): void {
    const line = `${new Date().toISOString().slice(11, 19)} ${level} ${msg}`;
    this.logLines.push(line);
    if (this.logLines.length > 200) this.logLines.splice(0, this.logLines.length - 200);
    if (level !== 'info') console.warn('[live-room]', msg);
  }

  async copyCode(): Promise<void> {
    if (!this.settings.roomCode) return void new Notice('No room code yet.');
    await navigator.clipboard.writeText(this.settings.roomCode);
    new Notice('Room code copied.');
  }

  async newRoom(): Promise<void> {
    this.settings.roomCode = generateRoomCode();
    await this.saveSettings();
  }

  // ------------------------------------------------------------------ vault glue

  private makeVaultAdapter(): VaultAdapter {
    const vault = this.app.vault;
    const fileAt = (p: string): TFile | null => {
      const f = vault.getAbstractFileByPath(p);
      return f instanceof TFile ? f : null;
    };
    const ensureFolder = async (path: string) => {
      const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      if (!dir || (await vault.adapter.exists(dir))) return;
      let acc = '';
      for (const seg of dir.split('/')) {
        acc = acc ? acc + '/' + seg : seg;
        if (!(await vault.adapter.exists(acc))) {
          try {
            await vault.createFolder(acc);
          } catch {
            /* another call made it first */
          }
        }
      }
    };
    return {
      list: async () => vault.getFiles().map((f) => ({ path: f.path, size: f.stat.size })),
      exists: (p) => vault.adapter.exists(p),
      size: async (p) => fileAt(p)?.stat.size ?? null,
      readText: async (p) => {
        const f = fileAt(p);
        return f ? vault.read(f) : null;
      },
      readBinary: async (p) => {
        const f = fileAt(p);
        return f ? vault.readBinary(f) : null;
      },
      writeText: async (p, data) => {
        const f = fileAt(p);
        if (f) await vault.modify(f, data);
        else {
          await ensureFolder(p);
          await vault.create(p, data);
        }
      },
      writeBinary: async (p, data) => {
        const f = fileAt(p);
        if (f) await vault.modifyBinary(f, data);
        else {
          await ensureFolder(p);
          await vault.createBinary(p, data);
        }
      },
      trash: async (p) => {
        const f = fileAt(p);
        if (f) await this.app.fileManager.trashFile(f);
      },
    };
  }

  private makePersist(roomHash: string): Persist {
    const dir = this.manifest.dir ?? normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}`);
    const path = normalizePath(`${dir}/state-${roomHash}.bin`);
    const adapter = this.app.vault.adapter;
    return {
      load: async () => ((await adapter.exists(path)) ? new Uint8Array(await adapter.readBinary(path)) : null),
      save: async (data) => {
        await adapter.writeBinary(path, toArrayBuffer(data));
      },
    };
  }
}

// -------------------------------------------------------------------- UI

class FirstRunModal extends Modal {
  constructor(
    app: App,
    private onOk: () => void | Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Before the first sync' });
    contentEl.createEl('p', {
      text: 'Live Room Sync will create, change and move notes in this vault to match the other devices in your room.',
    });
    contentEl.createEl('p', {
      text: 'Please make a copy of your vault folder first (copy and paste the folder somewhere safe). This plugin is new and a backup keeps your notes safe.',
    });
    contentEl.createEl('p', {
      text: 'If a note differs between devices, both versions are kept: one as a new note named "(conflict ...)".',
    });
    new Setting(contentEl)
      .addButton((b) =>
        b
          .setButtonText('I made a backup, start')
          .setCta()
          .onClick(async () => {
            this.close();
            await this.onOk();
          }),
      )
      .addButton((b) => b.setButtonText('Not now').onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class LiveRoomSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: LiveRoomSync,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    containerEl.createEl('p', {
      text: 'Everyone (and every device) that uses the same room code shares this whole vault. Notes update live while you type. Devices connect straight to each other, so at least two of them must be open at the same time to sync.',
    });

    new Setting(containerEl)
      .setName('Room code')
      .setDesc('Create a new room on your first device, then paste the same code on every other device. Keep it private: anyone with the code can read and change your notes.')
      .addText((t) => {
        t.setPlaceholder('XXXXX-XXXXX-XXXXX-XXXXX')
          .setValue(s.roomCode)
          .onChange(async (v) => {
            s.roomCode = v.trim();
            await this.plugin.saveSettings();
          });
        t.inputEl.addClass('live-room-code');
        t.inputEl.addEventListener('blur', () => void this.plugin.restart());
      })
      .addButton((b) =>
        b.setButtonText('Create new').onClick(async () => {
          await this.plugin.newRoom();
          await this.plugin.restart();
          this.display();
        }),
      )
      .addButton((b) => b.setButtonText('Copy').onClick(() => void this.plugin.copyCode()));

    new Setting(containerEl)
      .setName('Device name')
      .setDesc('Shown next to your cursor for other people.')
      .addText((t) =>
        t.setValue(s.deviceName).onChange(async (v) => {
          s.deviceName = v;
          await this.plugin.saveSettings();
          this.plugin.updateUser();
        }),
      );

    new Setting(containerEl)
      .setName('Cursor color')
      .addColorPicker((c) =>
        c.setValue(s.color).onChange(async (v) => {
          s.color = v;
          await this.plugin.saveSettings();
          this.plugin.updateUser();
        }),
      );

    new Setting(containerEl)
      .setName('Live typing')
      .setDesc('See other people type and move their cursor in the open note.')
      .addToggle((t) =>
        t.setValue(s.liveTyping).onChange(async (v) => {
          s.liveTyping = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Sync pictures and other files')
      .setDesc('Copies attachments (images, PDFs, videos...) between devices. Restarts syncing when changed.')
      .addToggle((t) =>
        t.setValue(s.syncAttachments).onChange(async (v) => {
          s.syncAttachments = v;
          await this.plugin.saveSettings();
          await this.plugin.restart();
        }),
      );

    new Setting(containerEl)
      .setName('Biggest attachment (MB)')
      .setDesc('Bigger files are skipped.')
      .addText((t) =>
        t.setValue(String(s.maxAttachmentMB)).onChange(async (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n > 0) {
            s.maxAttachmentMB = n;
            await this.plugin.saveSettings();
          }
        }),
      );

    new Setting(containerEl)
      .setName('Folders not to sync')
      .setDesc('One folder per line. Hidden folders and the .obsidian folder are never synced.')
      .addTextArea((t) =>
        t.setValue(s.excludedFolders).onChange(async (v) => {
          s.excludedFolders = v;
          await this.plugin.saveSettings();
        }),
      );

    containerEl.createEl('h3', { text: 'If connecting does not work' });

    new Setting(containerEl)
      .setName('Network')
      .setDesc('How devices find each other. All devices in a room must use the same one. Try another if devices cannot see each other.')
      .addDropdown((d) =>
        d
          .addOptions({ nostr: 'Nostr (default)', torrent: 'BitTorrent trackers', mqtt: 'MQTT' })
          .setValue(s.network)
          .onChange(async (v) => {
            s.network = v as NetworkKind;
            await this.plugin.saveSettings();
            await this.plugin.restart();
          }),
      );

    new Setting(containerEl)
      .setName('TURN server (advanced, optional)')
      .setDesc('JSON like [{"urls":"turn:example.com:3478","username":"u","credential":"p"}]. Only needed on very strict networks.')
      .addTextArea((t) =>
        t.setValue(s.turnJson).onChange(async (v) => {
          s.turnJson = v;
          await this.plugin.saveSettings();
        }),
      )
      .addButton((b) => b.setButtonText('Apply').onClick(() => void this.plugin.restart()));

    new Setting(containerEl)
      .setName('Reconnect')
      .addButton((b) => b.setButtonText('Reconnect now').onClick(() => void this.plugin.restart()));
  }
}
