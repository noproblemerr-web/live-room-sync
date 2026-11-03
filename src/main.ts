import { EventRef, MarkdownView, Notice, Platform, Plugin, TFile, normalizePath } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import { selfId } from '@trystero-p2p/nostr';
import { SyncEngine, type Persist, type VaultAdapter } from './engine';
import { RoomProvider, type GateDecision, type PeerInfo, type Transport } from './provider';
import { History, whenText, type HistoryStore } from './history';
import { TrysteroTransport } from './transport-trystero';
import type { TurnServerConfig } from '@trystero-p2p/core';
import { CmBinder } from './cm-binder';
import { createIdentity, signText } from './identity';
import { defaultSettings, ago, type Settings } from './settings';
import {
  FirstRunModal,
  HistoryModal,
  JoinModal,
  LiveRoomSettingTab,
  PartyView,
  VIEW_TYPE,
  type Member,
  type PartyHost,
  type PartyStatus,
} from './ui';
import {
  INVITE_PROTOCOL,
  checkRoomCode,
  codeFromPaste,
  formatRoomCode,
  generateRoomCode,
  inviteLink,
  isTextPath,
  normalizeRoomCode,
  sha256Hex,
  toArrayBuffer,
} from './util';

const defaultName = () =>
  Platform.isMacOS ? 'Mac' : Platform.isWin ? 'Windows PC' : Platform.isIosApp ? 'iPhone' : Platform.isAndroidApp ? 'Android' : 'Device';

const GUEST_WINDOW_MS = 3 * 60 * 1000;

export default class LiveRoomSync extends Plugin implements PartyHost {
  settings: Settings = defaultSettings(defaultName(), false);

  private engine: SyncEngine | null = null;
  private provider: RoomProvider | null = null;
  private transport: Transport | null = null;
  private history: History | null = null;
  private lastPath: string | null = null;
  private lastAuto = 0;
  private hereIds = new Map<string, { name: string; avatar: string }>();
  private binder = new CmBinder(this.binderHost());
  private eventRefs: EventRef[] = [];
  private statusEl: HTMLElement | null = null;
  private starting = false;
  private lastError = '';
  private logLines: string[] = [];
  private metaTimer: number | null = null;
  private lastFile: string | null = null;
  private lastSignature = '';
  private lastTouch = 0;
  private asked = new Set<string>();
  /** set by the settings page while it is open, so it can redraw when the party changes */
  settingsRefresh: (() => void) | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    if (!this.settings.identity) {
      this.settings.identity = await createIdentity();
      await this.saveSettings();
    }
    this.history = new History(this.makeHistoryStore());
    this.registerEditorExtension(this.binder.extension);
    this.registerView(VIEW_TYPE, (leaf) => new PartyView(leaf, this));
    this.addRibbonIcon('users', 'Open party panel', () => void this.openParty());

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass('live-room-status');
    this.statusEl.addClass('mod-clickable');
    this.statusEl.addEventListener('click', () => void this.openParty());
    this.registerInterval(window.setInterval(() => this.heartbeat(), 1000));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.heartbeat()));
    this.registerEvent(this.app.workspace.on('layout-change', () => this.heartbeat()));
    this.registerEvent(this.app.workspace.on('file-open', () => this.heartbeat()));

    this.registerObsidianProtocolHandler(INVITE_PROTOCOL, (params) => {
      new JoinModal(this.app, this, params.code ?? '').open();
    });

    this.addCommand({ id: 'open-party', name: 'Open party panel', callback: () => void this.openParty() });
    this.addCommand({ id: 'copy-invite', name: 'Copy invite link', callback: () => void this.copyInvite() });
    this.addCommand({ id: 'join-party', name: 'Join a party', callback: () => new JoinModal(this.app, this).open() });
    this.addCommand({
      id: 'note-history',
      name: 'Show history of this note',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !isTextPath(file.path)) return false;
        if (!checking) void this.showHistory();
        return true;
      },
    });
    this.addCommand({ id: 'copy-room-code', name: 'Copy room code', callback: () => void this.copyCode() });
    this.addCommand({ id: 'reconnect', name: 'Reconnect', callback: () => void this.restart() });
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

    this.addSettingTab(new LiveRoomSettingTab(this.app, this, this, () => void this.openParty()));

    this.app.workspace.onLayoutReady(() => void this.startSync());
  }

  onunload(): void {
    void this.stopSync();
  }

  // ------------------------------------------------------------------ settings

  async loadSettings(): Promise<void> {
    const saved = (await this.loadData()) as Partial<Settings> | null;
    this.settings = Object.assign(defaultSettings(defaultName(), Platform.isMobile), saved ?? {});
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private queueMetaSave(): void {
    if (this.metaTimer) window.clearTimeout(this.metaTimer);
    this.metaTimer = window.setTimeout(() => {
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
        onSnapshot: (path, text, reason) => void this.history?.record(path, text, reason),
        // as a guest, the notes that were already here stay private
        localOnly: this.settings.role === 'guest' ? this.settings.localOnly : [],
        onLocalOnlyChange: (paths) => {
          this.settings.localOnly = paths;
          this.queueMetaSave();
        },
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

      const transport = await this.createTransport(code);
      this.transport = transport;
      const id = this.settings.identity!;
      const provider = new RoomProvider(engine.doc, engine.awareness, transport, {
        room: roomHash,
        pub: id.pub,
        sign: (text) => signText(id.priv, text),
        profile: () => ({ name: this.settings.deviceName, avatar: this.settings.avatar, color: this.settings.color }),
        decide: (peer) => this.decide(peer),
      });
      this.provider = provider;
      engine.setNet({
        peers: () => provider.allowedPeers(),
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
        this.onRoster();
        this.renderStatus();
      };
      provider.onWant = (h, from) => void engine.handleWant(h, from);
      provider.onBlob = (h, d) => void engine.receiveBlob(h, d);
      engine.awareness.on('change', () => this.refreshViews());
      this.log('info', `joined room via ${this.settings.network}`);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.log('error', 'start failed: ' + this.lastError);
      await this.stopSync();
    } finally {
      this.starting = false;
      this.renderStatus();
      this.refreshViews();
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
    this.lastFile = null;
    this.lastPath = null;
    this.hereIds = new Map();
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
    this.refreshViews();
  }

  /** Tests replace this with an in-memory transport. */
  protected async createTransport(code: string): Promise<Transport> {
    return TrysteroTransport.create({ code, network: this.settings.network, turn: this.parseTurn(), selfId });
  }

  private parseTurn() {
    const raw = this.settings.turnJson.trim();
    if (!raw) return undefined;
    try {
      const v = JSON.parse(raw) as TurnServerConfig | TurnServerConfig[];
      return Array.isArray(v) ? v : [v];
    } catch {
      new Notice('Live Room Sync: the TURN server text is not valid JSON, ignoring it.');
      return undefined;
    }
  }

  // ------------------------------------------------------------------ who is allowed in

  /** Decides what to do when a device asks to join. See the README ("Joining and approval"). */
  private decide(peer: PeerInfo): GateDecision {
    const known = this.settings.people[peer.id];
    if (known?.status === 'blocked') return 'block';
    const guest = Date.now() < this.settings.guestUntil;
    if (known?.status === 'trusted' || guest || !this.settings.askBeforeJoin) {
      this.remember(peer, 'trusted');
      return 'allow';
    }
    return 'ask';
  }

  private remember(peer: { id: string; name: string; avatar: string; color: string }, status: 'trusted' | 'blocked'): void {
    this.settings.people[peer.id] = {
      name: peer.name,
      avatar: peer.avatar,
      color: peer.color,
      lastSeen: Date.now(),
      status,
    };
    void this.saveSettings();
  }

  allow(peerId: string): void {
    const r = this.provider?.roster().find((x) => x.peerId === peerId);
    if (r?.info) this.remember(r.info, 'trusted');
    this.provider?.approve(peerId);
  }

  block(peerId: string): void {
    const r = this.provider?.roster().find((x) => x.peerId === peerId);
    if (r?.info) this.remember(r.info, 'blocked');
    this.provider?.block(peerId);
  }

  async forget(id: string): Promise<void> {
    delete this.settings.people[id];
    await this.saveSettings();
    this.refreshViews(true);
  }

  /** Keep the friends list fresh and tell the person when someone is waiting. */
  private onRoster(): void {
    const roster = this.provider?.roster() ?? [];
    const here = new Map<string, { name: string; avatar: string }>();
    for (const r of roster) if (r.state === 'allowed' && r.info) here.set(r.info.id, { name: r.info.name, avatar: r.info.avatar });
    if (this.settings.showToasts) {
      for (const [id, p] of here) if (!this.hereIds.has(id)) new Notice(`${p.avatar} ${p.name} joined the party`);
      for (const [id, p] of this.hereIds) if (!here.has(id)) new Notice(`${p.avatar} ${p.name} left the party`);
    }
    this.hereIds = here;
    for (const r of roster) {
      if (r.state === 'pending' && r.info && !this.asked.has(r.peerId)) {
        this.asked.add(r.peerId);
        new Notice(`${r.info.avatar} ${r.info.name} wants to join your party. Open the Party panel to allow.`, 10000);
      }
      if (r.state === 'allowed' && r.info) this.touch(r.info);
    }
    this.refreshViews();
  }

  private touch(info: { id: string; name: string; avatar: string; color: string }): void {
    const p = this.settings.people[info.id];
    if (p?.status === 'blocked') return;
    if (p && p.name === info.name && p.avatar === info.avatar && p.color === info.color && Date.now() - p.lastSeen < 60_000) return;
    this.remember(info, 'trusted');
  }

  // ------------------------------------------------------------------ party actions (used by the UI)

  async startParty(): Promise<void> {
    this.settings.role = 'host';
    this.settings.localOnly = [];
    this.settings.roomCode = generateRoomCode();
    this.settings.guestUntil = 0;
    await this.saveSettings();
    await this.restart();
    await this.openParty();
    new Notice('Party started! Press "Invite friends" to share it.');
  }

  async joinParty(codeOrLink: string): Promise<void> {
    const r = checkRoomCode(codeFromPaste(codeOrLink));
    if (!r.clean) return void new Notice('That does not look like a party code.');
    // Joining someone's party: the notes already in this vault stay private, so they can never be
    // pushed into the host's vault. (Joining the same party again keeps the list as it was.)
    const sameParty = this.settings.role === 'guest' && normalizeRoomCode(this.settings.roomCode) === r.clean;
    if (!sameParty) this.settings.localOnly = this.app.vault.getFiles().map((f) => f.path);
    this.settings.role = 'guest';
    this.settings.roomCode = formatRoomCode(r.clean);
    this.settings.guestUntil = Date.now() + GUEST_WINDOW_MS;
    await this.saveSettings();
    await this.restart();
    await this.openParty();
  }

  async leaveParty(): Promise<void> {
    await this.stopSync();
    this.settings.roomCode = '';
    this.settings.role = 'host';
    this.settings.localOnly = [];
    this.settings.guestUntil = 0;
    this.settings.metaRoom = '';
    this.settings.known = {};
    await this.saveSettings();
    this.renderStatus();
    this.refreshViews(true);
    new Notice('You left the party. Your notes stay on this device.');
  }

  async copyInvite(): Promise<void> {
    if (!this.settings.roomCode) return void new Notice('Start a party first.');
    await navigator.clipboard.writeText(inviteLink(this.settings.roomCode, this.settings.deviceName));
    new Notice('Invite link copied. Send it to your friends.');
  }

  async copyCode(): Promise<void> {
    if (!this.settings.roomCode) return void new Notice('No party yet.');
    await navigator.clipboard.writeText(this.settings.roomCode);
    new Notice('Party code copied. Keep it private.');
  }

  async setProfile(p: { name: string; avatar: string; color: string }): Promise<void> {
    this.settings.deviceName = p.name;
    this.settings.avatar = p.avatar;
    this.settings.color = p.color;
    await this.saveSettings();
    this.updateUser();
    this.refreshViews(true);
  }

  vaultFileCount(): number {
    return this.app.vault.getFiles().length;
  }

  openNote(path: string): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) void this.app.workspace.getLeaf(false).openFile(file);
    else new Notice('That note has not arrived on this device yet.');
  }

  async showHistory(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file || !isTextPath(file.path)) return void new Notice('Open a note first.');
    const versions = (await this.history?.list(file.path)) ?? [];
    if (!versions.length) {
      return void new Notice('No earlier versions yet. They are saved when a friend changes a note, and now and then while you work.');
    }
    new HistoryModal(this.app, file.basename, versions, async (v) => {
      const current = await this.app.vault.read(file);
      await this.history?.record(file.path, current, 'restore');
      await this.app.vault.modify(file, v.text);
      new Notice(`Restored the version from ${whenText(v.t)}.`);
    }).open();
  }

  async openParty(): Promise<void> {
    const ws = this.app.workspace;
    let leaf = ws.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      const right = ws.getRightLeaf(false);
      if (!right) return;
      await right.setViewState({ type: VIEW_TYPE, active: true });
      leaf = right;
    }
    await ws.revealLeaf(leaf);
    this.refreshViews(true);
  }

  // ------------------------------------------------------------------ what the panel shows

  members(): Member[] {
    const s = this.settings;
    const out: Member[] = [];
    const awareness = this.engine?.awareness;
    const live = new Map<string, { name?: string; avatar?: string; color?: string; file?: string; path?: string; role?: string }>();
    if (awareness) {
      for (const st of awareness.getStates().values()) {
        const u = (st as { user?: { id?: string; pname?: string; avatar?: string; color?: string; file?: string; path?: string; role?: string } }).user;
        if (u?.id) live.set(u.id, { name: u.pname, avatar: u.avatar, color: u.color, file: u.file, path: u.path, role: u.role });
      }
    }
    const note = (file?: string) => (file ? `Editing ${file}` : 'Online');

    out.push({
      id: s.identity?.id ?? 'me',
      name: s.deviceName,
      avatar: s.avatar,
      color: s.color,
      kind: 'me',
      note: this.lastFile ? `Editing ${this.lastFile}` : 'You',
      host: s.role === 'host' && !!normalizeRoomCode(s.roomCode),
    });

    const here = new Set<string>();
    for (const r of this.provider?.roster() ?? []) {
      if (!r.info) continue;
      if (r.state === 'allowed') {
        const l = live.get(r.info.id);
        here.add(r.info.id);
        out.push({
          id: r.info.id,
          name: l?.name || r.info.name,
          avatar: l?.avatar || r.info.avatar,
          color: l?.color || r.info.color,
          kind: 'here',
          peerId: r.peerId,
          note: note(l?.file),
          path: l?.path,
          host: l?.role === 'host',
        });
      } else if (r.state === 'pending') {
        out.push({ id: r.info.id, name: r.info.name, avatar: r.info.avatar, color: r.info.color, kind: 'waiting', peerId: r.peerId });
      }
    }
    const now = Date.now();
    const away = Object.entries(s.people)
      .filter(([id, p]) => p.status === 'trusted' && !here.has(id) && id !== s.identity?.id)
      .sort((a, b) => b[1].lastSeen - a[1].lastSeen);
    for (const [id, p] of away) {
      out.push({ id, name: p.name, avatar: p.avatar, color: p.color, kind: 'away', note: `Partied together ${ago(p.lastSeen, now)}` });
    }
    return out;
  }

  status(): PartyStatus {
    const hasRoom = !!normalizeRoomCode(this.settings.roomCode);
    const here = this.provider?.peerCount() ?? 0;
    let summary: string;
    if (!hasRoom) summary = 'Share your notes live';
    else if (this.settings.paused) summary = 'Paused';
    else if (this.lastError) summary = 'Could not connect';
    else if (!this.engine || !this.transport) summary = this.starting ? 'Connecting…' : 'Not connected';
    else if (here === 0) summary = 'Waiting for friends';
    else summary = `${here + 1} in the party`;
    return { hasRoom, paused: this.settings.paused, error: this.lastError, summary };
  }

  /** Redraw open party panels, but only when something changed. */
  private refreshViews(force = false): void {
    const sig = JSON.stringify([this.status(), this.members()]);
    if (!force && sig === this.lastSignature) return;
    this.lastSignature = sig;
    this.settingsRefresh?.();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const v = leaf.view;
      if (v instanceof PartyView) v.render();
    }
  }

  // ------------------------------------------------------------------ you in the room

  private userState(file: string | null, path: string | null) {
    const s = this.settings;
    return {
      id: s.identity?.id,
      pname: s.deviceName,
      name: `${s.avatar} ${s.deviceName}`, // what shows next to your cursor
      avatar: s.avatar,
      color: s.color,
      colorLight: s.color + '33',
      file: s.showActivity ? file : null,
      path: s.showActivity ? path : null,
      role: s.role,
    };
  }

  private setLocalUser(engine: SyncEngine): void {
    engine.awareness.setLocalStateField('user', this.userState(this.lastFile, this.lastPath));
  }

  updateUser(): void {
    if (this.engine) this.setLocalUser(this.engine);
  }

  // ------------------------------------------------------------------ editors

  private binderHost() {
    return {
      getAwareness: () => this.engine!.awareness,
      getText: (p: string) => this.engine?.getText(p) ?? null,
      setBound: (p: string, b: boolean) => this.engine?.setBound(p, b),
      reconcile: (p: string) => void this.engine?.reconcileNow(p),
      log: (m: string) => this.log('info', m),
    };
  }

  private heartbeat(): void {
    this.renderStatus();
    const engine = this.engine;
    if (engine) {
      // tell the party which note you are in (just its name)
      const active = this.app.workspace.getActiveFile();
      const name = active && isTextPath(active.path) && engine.shouldSync(active.path) ? active.basename : null;
      const path = name && active ? active.path : null;
      if (name !== this.lastFile || path !== this.lastPath) {
        this.lastFile = name;
        this.lastPath = path;
        this.updateUser();
      }
      if (path && Date.now() - this.lastAuto > 30_000) {
        // now and then, keep a copy of the note you are working in (for note history)
        this.lastAuto = Date.now();
        const text = engine.getText(path);
        if (text) void this.history?.record(path, text.toString(), 'auto');
      }
      if (Date.now() - this.lastTouch > 30_000) {
        this.lastTouch = Date.now();
        for (const r of this.provider?.roster() ?? []) if (r.state === 'allowed' && r.info) this.touch(r.info);
      }
    }
    this.refreshViews();
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
    const peers = this.provider?.peerCount() ?? 0;
    const waiting = (this.provider?.roster() ?? []).filter((r) => r.state === 'pending').length;
    if (this.settings.paused) [text, title] = ['Party: paused', 'Syncing is paused'];
    else if (!normalizeRoomCode(this.settings.roomCode)) [text, title] = ['Party: none', 'Click to start or join a party'];
    else if (this.lastError) [text, title] = ['Party: error', this.lastError];
    else if (!this.engine || !this.transport) {
      [text, title] = this.starting ? ['Party: starting', 'Starting'] : ['Party: off', 'Not connected. Use the command "Live Room Sync: Reconnect".'];
    } else if (peers === 0) [text, title] = [waiting ? `Party: ${waiting} waiting` : 'Party: just you', 'Waiting for friends. Click to open the party panel.'];
    else {
      const s = this.engine.status();
      text = `Party: ${peers + 1} here${s.pending ? ' · syncing' : ''}${waiting ? ` · ${waiting} waiting` : ''}`;
      title = `${peers + 1} people in the party, ${s.files} files shared. Click to open the party panel.`;
    }
    if (el.getText() !== text) el.setText(text);
    el.setAttr('title', title);
  }

  private log(level: string, msg: string): void {
    const line = `${new Date().toISOString().slice(11, 19)} ${level} ${msg}`;
    this.logLines.push(line);
    if (this.logLines.length > 200) this.logLines.splice(0, this.logLines.length - 200);
    if (level === 'error') console.error('[live-room]', msg);
    else if (level !== 'info') console.debug('[live-room]', msg);
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

  private makeHistoryStore(): HistoryStore {
    const base = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    const dir = normalizePath(`${base}/history`);
    const adapter = this.app.vault.adapter;
    return {
      read: async (key) => {
        const p = normalizePath(`${dir}/${key}`);
        return (await adapter.exists(p)) ? adapter.read(p) : null;
      },
      write: async (key, data) => {
        if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
        await adapter.write(normalizePath(`${dir}/${key}`), data);
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
