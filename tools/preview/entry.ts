// Draws the plugin's real party panel and dialogs (src/ui.ts and styles.css) in a browser.
// Pick a scene with ?scene=empty|waiting|request|party|join|typo|profile|history|firstrun
import './shim';
import { FirstRunModal, HistoryModal, JoinModal, PartyView, ProfileModal, type Member, type PartyHost } from '../../src/ui';
import { defaultSettings } from '../../src/settings';
import type { Version } from '../../src/history';

const now = Date.now();
const me: Member = { id: 'me', name: 'Maya', avatar: '🦊', color: '#0091ff', kind: 'me', note: 'Editing Weekend plan' };
const leo: Member = { id: 'leo', name: 'Leo', avatar: '🐼', color: '#f76b15', kind: 'here', peerId: 'p1', note: 'Editing Robot ideas', path: 'Projects/Robot ideas.md' };
const zoe: Member = { id: 'zoe', name: 'Zoe', avatar: '🐸', color: '#30a46c', kind: 'here', peerId: 'p2', note: 'Online' };
const sam: Member = { id: 'sam', name: 'Sam', avatar: '🦄', color: '#8e4ec6', kind: 'away', note: 'Partied together 4d ago' };
const kai: Member = { id: 'kai', name: 'Kai', avatar: '🐙', color: '#d6409f', kind: 'waiting', peerId: 'p3' };

const scenes: Record<string, { hasRoom: boolean; summary: string; members: Member[] }> = {
  empty: { hasRoom: false, summary: 'Share your notes live', members: [] },
  waiting: { hasRoom: true, summary: 'Waiting for friends', members: [me] },
  request: { hasRoom: true, summary: 'Waiting for friends', members: [me, kai] },
  party: { hasRoom: true, summary: '3 in the party', members: [me, leo, zoe, sam] },
};

const scene = new URLSearchParams(location.search).get('scene') ?? 'party';
const settings = defaultSettings('Maya', false);
settings.avatar = '🦊';
settings.color = '#0091ff';
const s = scenes[scene] ?? scenes.party;

const host = {
  app: {},
  settings,
  saveSettings: async () => {},
  members: () => s.members,
  status: () => ({ hasRoom: s.hasRoom, paused: false, error: '', summary: s.summary }),
  startParty: async () => {},
  joinParty: async () => {},
  leaveParty: async () => {},
  copyInvite: async () => {},
  copyCode: async () => {},
  allow: () => {},
  block: () => {},
  forget: async () => {},
  setProfile: async () => {},
  restart: async () => {},
  openNote: () => {},
  settingsRefresh: null,
} as unknown as PartyHost;

const stage = document.getElementById('stage')!;
if (['empty', 'waiting', 'request', 'party'].includes(scene)) {
  const view = new PartyView({} as never, host);
  stage.appendChild(view.contentEl);
  void view.onOpen();
} else {
  document.body.classList.add('modal-scene');
  const app = {} as never;
  if (scene === 'join') new JoinModal(app, host, '4RJ9G-MCQ5F-3ET2U-Q5BQS').open();
  if (scene === 'typo') new JoinModal(app, host, '4RJ9G-MCQ5F-3ET2U-Q5BQT').open();
  if (scene === 'profile') new ProfileModal(app, host).open();
  if (scene === 'firstrun') new FirstRunModal(app, () => {}).open();
  if (scene === 'history') {
    const v: Version[] = [
      { t: now - 4 * 60_000, reason: 'remote', text: '# Weekend plan\n\n- Finish the robot path notes\n- Share this vault with a friend\n' },
      { t: now - 55 * 60_000, reason: 'auto', text: '# Weekend plan\n\n- Finish the robot path notes\n' },
      { t: now - 26 * 3_600_000, reason: 'merge', text: '# Weekend plan\n' },
    ];
    new HistoryModal(app, 'Weekend plan', v, async () => {}).open();
  }
}
