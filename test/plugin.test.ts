// Two real copies of the whole plugin (not just the sync engine), joined through an in-memory
// network. This is the join flow a person goes through: start, invite, join, allow, sync.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import * as fake from './fake-obsidian';
import { Hub, MemTransport, waitFor, sleep } from './helpers';
import { checkRoomCode, inviteLink } from '../src/util';

const M = Module as unknown as { _load: (req: string, ...rest: unknown[]) => unknown };
const originalLoad = M._load;
M._load = function (this: unknown, req: string, ...rest: unknown[]) {
  return req === 'obsidian' ? fake : originalLoad.call(this, req, ...rest);
};
// loaded only now, so the plugin gets the fake Obsidian above
// eslint-disable-next-line @typescript-eslint/no-require-imports
const LiveRoomSync = require('../src/main').default as typeof import('../src/main').default;

class TestPlugin extends LiveRoomSync {
  constructor(
    app: fake.FakeApp,
    private hub: Hub,
    private who: string,
  ) {
    super(app as never, { id: 'live-room-sync', dir: '.obsidian/plugins/live-room-sync' } as never);
  }
  protected async createTransport() {
    const t = new MemTransport(this.who, this.hub);
    this.hub.join(t);
    return t;
  }
  get vault() {
    return (this.app as unknown as fake.FakeApp).vault;
  }
  get fakeApp() {
    return this.app as unknown as fake.FakeApp;
  }
  beat() {
    (this as unknown as { heartbeat(): void }).heartbeat();
  }
}

async function device(hub: Hub, name: string, avatar: string) {
  const p = new TestPlugin(new fake.FakeApp(), hub, name.toLowerCase());
  await p.onload();
  p.settings.deviceName = name;
  p.settings.avatar = avatar;
  p.settings.accepted = true; // skip the "I made a backup" prompt
  return p;
}

test('start a party, join with the invite, allow, and the notes arrive', async () => {
  fake.notices.length = 0;
  const hub = new Hub();
  const ann = await device(hub, 'Ann', '🦊');
  const bo = await device(hub, 'Bo', '🐼');
  ann.vault.files.set('Welcome.md', '# Weekend plan\n\n- one\n');

  await ann.startParty();
  assert.equal(checkRoomCode(ann.settings.roomCode).status, 'ok', 'a new party gets a good code');
  assert.deepEqual(ann.members().map((m) => m.kind), ['me']);

  // Bo joins from the invite link, like clicking it
  await bo.joinParty(inviteLink(ann.settings.roomCode, 'Ann'));
  assert.equal(bo.settings.roomCode.replace(/-/g, ''), ann.settings.roomCode.replace(/-/g, ''));

  // Ann sees the request and nothing has been shared yet
  await waitFor(() => ann.members().some((m) => m.kind === 'waiting'), 'request shows up', 15000);
  const waiting = ann.members().find((m) => m.kind === 'waiting')!;
  assert.equal(waiting.name, 'Bo');
  assert.equal(waiting.avatar, '🐼');
  await sleep(300);
  assert.equal(bo.vault.files.has('Welcome.md'), false, 'nothing is shared before Allow');

  ann.allow(waiting.peerId!);
  await waitFor(() => bo.vault.files.get('Welcome.md') === '# Weekend plan\n\n- one\n', 'note arrives', 20000);

  // both see each other, with name and picture
  await waitFor(() => ann.members().some((m) => m.kind === 'here' && m.name === 'Bo'), 'Bo is here', 8000);
  await waitFor(() => bo.members().some((m) => m.kind === 'here' && m.name === 'Ann'), 'Ann is here', 8000);
  assert.ok(fake.notices.some((n) => n.includes('Bo joined the party')), 'join message');

  // what a friend is editing, and a click opens that note
  bo.fakeApp.activeFile = new fake.TFile('Welcome.md');
  bo.beat();
  await waitFor(
    () => ann.members().find((m) => m.name === 'Bo')?.note === 'Editing Welcome',
    'shows what Bo is editing',
    8000,
  );
  const boRow = ann.members().find((m) => m.name === 'Bo')!;
  assert.equal(boRow.path, 'Welcome.md');
  ann.openNote(boRow.path!);
  assert.deepEqual(ann.fakeApp.opened, ['Welcome.md']);

  // Bo changes the note; Ann gets it, and Ann's old text is kept in note history
  bo.vault.userWrite('Welcome.md', '# Weekend plan\n\n- one\n- two from Bo\n');
  await waitFor(() => ann.vault.files.get('Welcome.md') === '# Weekend plan\n\n- one\n- two from Bo\n', 'edit arrives', 8000);
  const history = await (ann as unknown as { history: { list(p: string): Promise<{ text: string; reason: string }[]> } }).history.list('Welcome.md');
  assert.ok(history.some((v) => v.text === '# Weekend plan\n\n- one\n' && v.reason === 'remote'), 'earlier version kept');

  // Bo leaves: Ann sees a message and Bo moves to friends
  await bo.leaveParty();
  await waitFor(() => fake.notices.some((n) => n.includes('Bo left the party')), 'leave message', 8000);
  await waitFor(() => ann.members().some((m) => m.kind === 'away' && m.name === 'Bo'), 'Bo is a friend now', 8000);
  assert.equal(bo.settings.roomCode, '');
  assert.equal(bo.vault.files.has('Welcome.md'), true, 'leaving keeps the notes');

  await ann.onunload();
});

test('a mistyped code does not start a party', async () => {
  const hub = new Hub();
  const bo = await device(hub, 'Bo', '🐼');
  await bo.joinParty('hello');
  assert.equal(bo.settings.roomCode, '');
});
