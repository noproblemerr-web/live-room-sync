import { App, ItemView, Modal, Notice, PluginSettingTab, Setting, WorkspaceLeaf, setIcon } from 'obsidian';
import { AVATARS, COLORS, type Settings } from './settings';
import { checkRoomCode, codeFromPaste } from './util';
import { REASON_TEXT, whenText, type Version } from './history';
import type { NetworkKind } from './transport-trystero';

export const VIEW_TYPE = 'live-room-party';

/** One row in the party list. */
export interface Member {
  id: string;
  name: string;
  avatar: string;
  color: string;
  /** me = you, here = in the party now, waiting = asked to join, away = partied before but not here now */
  kind: 'me' | 'here' | 'waiting' | 'away';
  peerId?: string;
  /** what they are doing, or when you last partied */
  note?: string;
  /** the note they have open, so you can jump to it */
  path?: string;
}

export interface PartyStatus {
  hasRoom: boolean;
  paused: boolean;
  error: string;
  /** a short line for the top of the panel */
  summary: string;
}

/** What the panel and settings need from the plugin. Keeps the UI easy to follow. */
export interface PartyHost {
  app: App;
  settings: Settings;
  saveSettings(): Promise<void>;
  members(): Member[];
  status(): PartyStatus;
  startParty(): Promise<void>;
  joinParty(codeOrLink: string): Promise<void>;
  leaveParty(): Promise<void>;
  copyInvite(): Promise<void>;
  copyCode(): Promise<void>;
  allow(peerId: string): void;
  block(peerId: string): void;
  forget(id: string): Promise<void>;
  setProfile(p: { name: string; avatar: string; color: string }): Promise<void>;
  restart(): Promise<void>;
  openNote(path: string): void;
  /** the settings page sets this while it is open */
  settingsRefresh: (() => void) | null;
}

// ------------------------------------------------------------------ small pieces

function avatar(parent: HTMLElement, m: { avatar: string; color: string }, online: boolean, big = false): HTMLElement {
  const wrap = parent.createDiv({ cls: 'lrs-avatar' + (big ? ' lrs-big' : '') });
  const face = wrap.createDiv({ cls: 'lrs-face', text: m.avatar });
  face.setCssProps({ '--lrs-color': m.color });
  if (online) wrap.createDiv({ cls: 'lrs-dot' });
  return wrap;
}

// ------------------------------------------------------------------ the party panel

export class PartyView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private host: PartyHost) {
    super(leaf);
  }
  getViewType(): string {
    return VIEW_TYPE;
  }
  getDisplayText(): string {
    return 'Party';
  }
  getIcon(): string {
    return 'users';
  }
  async onOpen(): Promise<void> {
    this.contentEl.addClass('lrs-party');
    this.render();
  }

  render(): void {
    const host = this.host;
    const root = this.contentEl;
    root.empty();
    const st = host.status();

    const hero = root.createDiv({ cls: 'lrs-hero' });
    hero.createDiv({ cls: 'lrs-title', text: 'Party up' });
    hero.createDiv({ cls: 'lrs-sub', text: st.summary });

    if (!st.hasRoom) {
      const empty = root.createDiv({ cls: 'lrs-empty' });
      empty.createDiv({ cls: 'lrs-emoji', text: '🎉' });
      empty.createDiv({ cls: 'lrs-lead', text: 'Share your notes live with friends' });
      empty.createDiv({ cls: 'lrs-muted', text: 'Start a party and send them the invite, or join one with a code.' });
      const start = empty.createEl('button', { text: 'Start a party', cls: 'mod-cta lrs-wide' });
      start.onclick = () => void host.startParty();
      const join = empty.createEl('button', { text: 'Join with a code or link', cls: 'lrs-wide' });
      join.onclick = () => new JoinModal(host.app, host).open();
      return;
    }

    if (st.error) root.createDiv({ cls: 'lrs-error', text: st.error });

    const people = host.members();
    const me = people.filter((p) => p.kind === 'me');
    const waiting = people.filter((p) => p.kind === 'waiting');
    const here = people.filter((p) => p.kind === 'here');
    const away = people.filter((p) => p.kind === 'away');

    for (const m of me) {
      const row = root.createDiv({ cls: 'lrs-card lrs-me' });
      avatar(row, m, true, true);
      const text = row.createDiv({ cls: 'lrs-text' });
      text.createDiv({ cls: 'lrs-name', text: m.name });
      text.createDiv({ cls: 'lrs-note', text: m.note ?? 'You' });
      const edit = row.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Edit your profile' } });
      setIcon(edit, 'pencil');
      edit.onclick = () => new ProfileModal(host.app, host).open();
    }

    if (waiting.length) {
      root.createDiv({ cls: 'lrs-heading', text: 'Wants to join' });
      for (const m of waiting) {
        const row = root.createDiv({ cls: 'lrs-card lrs-ask' });
        avatar(row, m, false);
        const text = row.createDiv({ cls: 'lrs-text' });
        text.createDiv({ cls: 'lrs-name', text: m.name });
        text.createDiv({ cls: 'lrs-note', text: 'Wants to join your party' });
        const buttons = row.createDiv({ cls: 'lrs-buttons' });
        const yes = buttons.createEl('button', { text: 'Allow', cls: 'mod-cta' });
        yes.onclick = () => m.peerId && host.allow(m.peerId);
        const no = buttons.createEl('button', { text: 'Block' });
        no.onclick = () => m.peerId && host.block(m.peerId);
      }
    }

    root.createDiv({ cls: 'lrs-heading', text: `In the party · ${here.length + me.length}` });
    if (!here.length) {
      root.createDiv({ cls: 'lrs-muted lrs-pad', text: 'Just you for now. Invite a friend and they will show up here.' });
    }
    for (const m of here) {
      const row = root.createDiv({ cls: 'lrs-card' });
      avatar(row, m, true);
      const text = row.createDiv({ cls: 'lrs-text' });
      text.createDiv({ cls: 'lrs-name', text: m.name });
      text.createDiv({ cls: 'lrs-note', text: m.note ?? 'Online' });
      if (m.path) {
        // click a friend to open the note they are in
        const path = m.path;
        row.addClass('lrs-click');
        row.setAttr('aria-label', `Open ${m.name}'s note`);
        row.onclick = () => host.openNote(path);
      }
    }

    if (away.length) {
      root.createDiv({ cls: 'lrs-heading', text: `Friends · ${away.length}` });
      for (const m of away) {
        const row = root.createDiv({ cls: 'lrs-card lrs-away' });
        avatar(row, m, false);
        const text = row.createDiv({ cls: 'lrs-text' });
        text.createDiv({ cls: 'lrs-name', text: m.name });
        text.createDiv({ cls: 'lrs-note', text: m.note ?? '' });
        const x = row.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Forget this friend' } });
        setIcon(x, 'x');
        x.onclick = () => void host.forget(m.id);
      }
    }

    const foot = root.createDiv({ cls: 'lrs-foot' });
    const invite = foot.createEl('button', { text: 'Invite friends', cls: 'mod-cta lrs-wide' });
    invite.onclick = () => void host.copyInvite();
    const row = foot.createDiv({ cls: 'lrs-buttons' });
    row.createEl('button', { text: 'Copy code' }).onclick = () => void host.copyCode();
    row.createEl('button', { text: 'Leave party' }).onclick = () => new LeaveModal(host.app, host).open();
  }
}

// ------------------------------------------------------------------ dialogs

export class FirstRunModal extends Modal {
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
      text: 'Live Room Sync will create, change and move notes in this vault to match the other devices in your party.',
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

export class JoinModal extends Modal {
  constructor(
    app: App,
    private host: PartyHost,
    private initial = '',
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    const s = this.host.settings;
    contentEl.addClass('lrs-modal');
    contentEl.createEl('h2', { text: 'Join a party' });
    contentEl.createEl('p', { text: 'Paste the code or invite link your friend sent you.', cls: 'lrs-muted' });
    const input = contentEl.createEl('input', { type: 'text', placeholder: 'XXXXX-XXXXX-XXXXX-XXXXX or invite link', cls: 'lrs-input' });
    input.value = this.initial;
    const msg = contentEl.createDiv({ cls: 'lrs-msg' });
    contentEl.createDiv({ cls: 'lrs-muted', text: `You will appear as ${s.avatar} ${s.deviceName}. You can change this later.` });
    const row = contentEl.createDiv({ cls: 'lrs-buttons lrs-end' });
    const cancel = row.createEl('button', { text: 'Cancel' });
    cancel.onclick = () => this.close();
    const join = row.createEl('button', { text: 'Join', cls: 'mod-cta' });

    const refresh = () => {
      const r = checkRoomCode(codeFromPaste(input.value));
      msg.removeClass('lrs-bad');
      msg.removeClass('lrs-good');
      join.disabled = r.status === 'empty' || r.status === 'short';
      join.setText('Join');
      if (r.status === 'ok') {
        msg.setText('✓ That looks like a good code.');
        msg.addClass('lrs-good');
      } else if (r.status === 'typo') {
        msg.setText('That code does not pass the check, so it may have a typo. Codes made by older versions will say this too.');
        msg.addClass('lrs-bad');
        join.setText('Join anyway');
      } else if (r.status === 'short') {
        msg.setText('That is too short for a code.');
        msg.addClass('lrs-bad');
      } else msg.setText('');
    };
    input.addEventListener('input', refresh);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !join.disabled) join.click();
    });
    join.onclick = async () => {
      this.close();
      await this.host.joinParty(input.value);
    };
    refresh();
    window.setTimeout(() => input.focus(), 50);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class ProfileModal extends Modal {
  constructor(
    app: App,
    private host: PartyHost,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    const s = this.host.settings;
    let name = s.deviceName;
    let face = s.avatar;
    let color = s.color;
    contentEl.addClass('lrs-modal');
    contentEl.createEl('h2', { text: 'Your profile' });
    const preview = contentEl.createDiv({ cls: 'lrs-preview' });
    const input = contentEl.createEl('input', { type: 'text', cls: 'lrs-input' });
    input.value = name;
    input.maxLength = 24;

    const drawPreview = () => {
      preview.empty();
      avatar(preview, { avatar: face, color }, true, true);
      preview.createDiv({ cls: 'lrs-name', text: name || 'Your name' });
    };
    input.addEventListener('input', () => {
      name = input.value;
      drawPreview();
    });

    contentEl.createDiv({ cls: 'lrs-heading', text: 'Picture' });
    const faces = contentEl.createDiv({ cls: 'lrs-grid' });
    const drawFaces = () => {
      faces.empty();
      for (const a of AVATARS) {
        const b = faces.createEl('button', { text: a, cls: 'lrs-pick' + (a === face ? ' lrs-on' : '') });
        b.onclick = () => {
          face = a;
          drawFaces();
          drawPreview();
        };
      }
    };
    contentEl.createDiv({ cls: 'lrs-heading', text: 'Color' });
    const colors = contentEl.createDiv({ cls: 'lrs-grid' });
    const drawColors = () => {
      colors.empty();
      for (const c of COLORS) {
        const b = colors.createEl('button', { cls: 'lrs-swatch' + (c === color ? ' lrs-on' : '') });
        b.setCssProps({ '--lrs-color': c });
        b.onclick = () => {
          color = c;
          drawColors();
          drawPreview();
        };
      }
    };
    drawFaces();
    drawColors();
    drawPreview();

    const row = contentEl.createDiv({ cls: 'lrs-buttons lrs-end' });
    row.createEl('button', { text: 'Cancel' }).onclick = () => this.close();
    row.createEl('button', { text: 'Save', cls: 'mod-cta' }).onclick = async () => {
      this.close();
      await this.host.setProfile({ name: name.trim() || s.deviceName, avatar: face, color });
    };
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Earlier versions of one note. Pick one to preview it, then restore it. */
export class HistoryModal extends Modal {
  constructor(
    app: App,
    private title: string,
    private versions: Version[],
    private onRestore: (v: Version) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('lrs-modal');
    contentEl.createEl('h2', { text: `History of "${this.title}"` });
    contentEl.createEl('p', {
      text: 'Earlier versions saved on this device. Restoring one is a normal edit: your friends get it too, and the version you replace is saved first.',
      cls: 'lrs-muted',
    });
    const list = contentEl.createDiv({ cls: 'lrs-versions' });
    const preview = contentEl.createEl('pre', { cls: 'lrs-previewtext', text: 'Pick a version to see it here.' });
    const row = contentEl.createDiv({ cls: 'lrs-buttons lrs-end' });
    row.createEl('button', { text: 'Close' }).onclick = () => this.close();
    const restore = row.createEl('button', { text: 'Restore this version', cls: 'mod-cta' });
    restore.disabled = true;
    let chosen: Version | null = null;

    for (const v of this.versions) {
      const item = list.createDiv({ cls: 'lrs-version' });
      item.createDiv({ cls: 'lrs-name', text: whenText(v.t) });
      item.createDiv({ cls: 'lrs-note', text: REASON_TEXT[v.reason] });
      item.onclick = () => {
        chosen = v;
        list.querySelectorAll('.lrs-version').forEach((e) => e.removeClass('lrs-on'));
        item.addClass('lrs-on');
        preview.setText(v.text.length > 3000 ? v.text.slice(0, 3000) + '\n…' : v.text);
        restore.disabled = false;
      };
    }
    restore.onclick = async () => {
      if (!chosen) return;
      this.close();
      await this.onRestore(chosen);
    };
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class LeaveModal extends Modal {
  constructor(
    app: App,
    private host: PartyHost,
  ) {
    super(app);
  }
  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Leave this party?' });
    contentEl.createEl('p', {
      text: 'Your notes stay on this device. They just stop syncing with the party. You can rejoin later with the code.',
    });
    const row = contentEl.createDiv({ cls: 'lrs-buttons lrs-end' });
    row.createEl('button', { text: 'Stay' }).onclick = () => this.close();
    row.createEl('button', { text: 'Leave party', cls: 'mod-warning' }).onclick = async () => {
      this.close();
      await this.host.leaveParty();
    };
  }
  onClose(): void {
    this.contentEl.empty();
  }
}

// ------------------------------------------------------------------ settings

export class LiveRoomSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    plugin: import('obsidian').Plugin,
    private host: PartyHost,
    private openPanel: () => void,
  ) {
    super(app, plugin);
  }

  hide(): void {
    this.host.settingsRefresh = null;
  }

  display(): void {
    const { containerEl } = this;
    const host = this.host;
    const s = host.settings;
    host.settingsRefresh = () => this.display();
    containerEl.empty();

    new Setting(containerEl)
      .setName('Your profile')
      .setDesc(`${s.avatar} ${s.deviceName}. This is how friends see you and your cursor.`)
      .addButton((b) => b.setButtonText('Edit').onClick(() => new ProfileModal(this.app, host).open()));

    new Setting(containerEl).setName('Party').setHeading();
    const hasRoom = host.status().hasRoom;
    if (!hasRoom) {
      new Setting(containerEl)
        .setName('No party yet')
        .setDesc('Start one and send your friends the invite, or join theirs with a code.')
        .addButton((b) =>
          b
            .setButtonText('Start a party')
            .setCta()
            .onClick(async () => {
              await host.startParty();
              this.display();
            }),
        )
        .addButton((b) => b.setButtonText('Join').onClick(() => new JoinModal(this.app, host).open()));
    } else {
      new Setting(containerEl)
        .setName('Invite friends')
        .setDesc('Copies a link. When they click it, Obsidian opens and joins the party.')
        .addButton((b) => b.setButtonText('Copy invite').setCta().onClick(() => void host.copyInvite()))
        .addButton((b) => b.setButtonText('Copy code').onClick(() => void host.copyCode()));
      new Setting(containerEl)
        .setName('Party panel')
        .setDesc('See who is here, who wants to join, and what everyone is working on.')
        .addButton((b) => b.setButtonText('Open panel').onClick(() => this.openPanel()))
        .addButton((b) =>
          b.setButtonText('Leave party').onClick(async () => {
            await host.leaveParty();
            this.display();
          }),
        );
    }

    new Setting(containerEl).setName('Syncing').setHeading();
    new Setting(containerEl)
      .setName('Live typing')
      .setDesc('See friends type and move their cursor in the note you have open.')
      .addToggle((t) =>
        t.setValue(s.liveTyping).onChange(async (v) => {
          s.liveTyping = v;
          await host.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName('Show which note I am in')
      .setDesc('Friends see "Editing Weekend plan" next to your name.')
      .addToggle((t) =>
        t.setValue(s.showActivity).onChange(async (v) => {
          s.showActivity = v;
          await host.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName('Show join and leave messages')
      .setDesc('A small message when someone joins or leaves the party.')
      .addToggle((t) =>
        t.setValue(s.showToasts).onChange(async (v) => {
          s.showToasts = v;
          await host.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName('Sync pictures and other files')
      .setDesc('Copies images, PDFs and other files too. Restarts syncing when changed.')
      .addToggle((t) =>
        t.setValue(s.syncAttachments).onChange(async (v) => {
          s.syncAttachments = v;
          await host.saveSettings();
          await host.restart();
        }),
      );
    new Setting(containerEl)
      .setName('Biggest file (MB)')
      .setDesc('Bigger files are skipped.')
      .addText((t) =>
        t.setValue(String(s.maxAttachmentMB)).onChange(async (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n > 0) {
            s.maxAttachmentMB = n;
            await host.saveSettings();
          }
        }),
      );
    new Setting(containerEl)
      .setName('Folders not to sync')
      .setDesc('One folder per line. Hidden folders and the Obsidian settings folder are never synced.')
      .addTextArea((t) =>
        t.setValue(s.excludedFolders).onChange(async (v) => {
          s.excludedFolders = v;
          await host.saveSettings();
        }),
      );

    const adv = containerEl.createEl('details', { cls: 'lrs-advanced' });
    adv.createEl('summary', { text: 'Advanced' });
    const box = adv.createDiv();
    new Setting(box)
      .setName('Ask before new devices join')
      .setDesc('When someone new joins with your code, you get Allow and Block buttons. Turn off to let anyone with the code in.')
      .addToggle((t) =>
        t.setValue(s.askBeforeJoin).onChange(async (v) => {
          s.askBeforeJoin = v;
          await host.saveSettings();
        }),
      );
    new Setting(box)
      .setName('Network')
      .setDesc('How devices find each other. Everyone in a party must use the same one. Try another if friends cannot see each other.')
      .addDropdown((d) =>
        d
          .addOptions({ nostr: 'Nostr (default)', torrent: 'BitTorrent trackers', mqtt: 'MQTT' })
          .setValue(s.network)
          .onChange(async (v) => {
            s.network = v as NetworkKind;
            await host.saveSettings();
            await host.restart();
          }),
      );
    new Setting(box)
      .setName('TURN server (optional)')
      .setDesc('JSON like [{"urls":"turn:example.com:3478","username":"u","credential":"p"}]. Only for very strict networks.')
      .addTextArea((t) =>
        t.setValue(s.turnJson).onChange(async (v) => {
          s.turnJson = v;
          await host.saveSettings();
        }),
      )
      .addButton((b) => b.setButtonText('Apply').onClick(() => void host.restart()));
    new Setting(box)
      .setName('Reconnect')
      .addButton((b) => b.setButtonText('Reconnect now').onClick(() => void host.restart()));
  }
}

export const toast = (m: string) => new Notice(m);
