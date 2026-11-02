import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, Device, waitFor, sleep } from './helpers';
import { createIdentity, signText } from '../src/identity';
import { helloText, type GateDecision } from '../src/provider';
import { checkRoomCode, codeFromPaste, generateRoomCode, inviteLink } from '../src/util';

const stopAll = async (devs: Device[]) => {
  for (const d of devs) await d.stop();
};
const conflicts = (d: Device) => d.vault.names().filter((n) => n.includes('(conflict'));

// ---------------------------------------------------------------- room codes

test('a new room code passes its check, a typo does not', () => {
  for (let i = 0; i < 50; i++) {
    const code = generateRoomCode();
    assert.equal(checkRoomCode(code).status, 'ok');
    // change one letter to a different one
    const raw = code.replace(/-/g, '');
    const at = i % raw.length;
    const swapped = 'ABCDEFGH'.includes(raw[at]) ? 'Z' : 'A';
    assert.equal(checkRoomCode(raw.slice(0, at) + swapped + raw.slice(at + 1)).status, 'typo');
  }
  assert.equal(checkRoomCode('ABC').status, 'short');
  assert.equal(checkRoomCode('  ').status, 'empty');
});

test('a code can be pulled out of an invite link and the link round-trips', () => {
  const code = generateRoomCode();
  const link = inviteLink(code, 'Billy & friends');
  assert.ok(link.startsWith('obsidian://live-room-sync?code='));
  assert.equal(checkRoomCode(codeFromPaste(link)).status, 'ok');
  assert.equal(checkRoomCode(codeFromPaste(`  ${code}  `)).status, 'ok');
});

// ---------------------------------------------------------------- joining

const pair = async (decideA?: () => GateDecision, decideB?: () => GateDecision) => {
  const hub = new Hub();
  const a = new Device('Ann', hub, { identity: await createIdentity(), decide: decideA });
  const b = new Device('Bo', hub, { identity: await createIdentity(), decide: decideB });
  return { hub, a, b };
};

test('both sides allow each other: notes flow both ways', async () => {
  const { a, b } = await pair();
  a.vault.files.set('from-a.md', 'hello from ann');
  b.vault.files.set('from-b.md', 'hello from bo');
  await a.start();
  await b.start();
  await waitFor(() => b.vault.text('from-a.md') === 'hello from ann' && a.vault.text('from-b.md') === 'hello from bo', 'both ways');
  assert.deepEqual(a.provider.roster().map((r) => r.info?.name), ['Bo']);
  await stopAll([a, b]);
});

test('a device waits until it is allowed, then everything arrives', async () => {
  let answer: GateDecision = 'ask';
  const { a, b } = await pair(() => answer);
  a.vault.files.set('private.md', 'only after approval');
  b.vault.files.set('bos.md', 'bo has this');
  await a.start();
  await b.start();
  await sleep(700);
  assert.equal(b.vault.text('private.md'), undefined, 'nothing is shared while waiting');
  assert.equal(a.vault.text('bos.md'), undefined);
  const pending = a.provider.roster().filter((r) => r.state === 'pending');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].info?.name, 'Bo');

  answer = 'allow';
  a.provider.approve(pending[0].peerId);
  await waitFor(() => b.vault.text('private.md') === 'only after approval' && a.vault.text('bos.md') === 'bo has this', 'shared after approval');
  await stopAll([a, b]);
});

test('a blocked device gets nothing and sends nothing', async () => {
  const { a, b } = await pair(() => 'block');
  a.vault.files.set('secret.md', 'mine');
  b.vault.files.set('intruder.md', 'theirs');
  await a.start();
  await b.start();
  await sleep(800);
  assert.equal(b.vault.text('secret.md'), undefined);
  assert.equal(a.vault.text('intruder.md'), undefined);
  assert.equal(a.provider.allowedPeers().length, 0);
  await stopAll([a, b]);
});

test('a hello signed for another connection is refused (no copying someone else\'s id)', async () => {
  const hub = new Hub();
  const a = new Device('Ann', hub, { identity: await createIdentity() });
  const victim = await createIdentity();
  a.vault.files.set('secret.md', 'mine');
  await a.start();

  // an outsider connects and replays the victim's public key with a signature made for a different peer id
  const outsider = new Device('Eve', hub, {});
  await outsider.start(false);
  outsider.transport = new (await import('./helpers')).MemTransport('eve-1', hub);
  outsider.transport.onMessage = () => {};
  hub.join(outsider.transport);
  const sig = await signText(victim.priv, helloText('test-room', 'someone-else'));
  await sleep(50);
  const body = JSON.stringify({ pub: victim.pub, sig, name: 'Victim', avatar: '🦊', color: '#0091ff' });
  outsider.transport.send('hi', new TextEncoder().encode(body));
  await sleep(300);
  const r = a.provider.roster().find((x) => x.peerId === 'eve-1');
  assert.equal(r?.state, 'blocked');
  await a.stop();
  await outsider.engine.stop();
});

// ---------------------------------------------------------------- renames

test('a rename keeps edits that were made on another device meanwhile', async () => {
  const hub = new Hub();
  const a = new Device('A', hub);
  const b = new Device('B', hub);
  a.vault.files.set('plans/old.md', 'line one\nline two\n');
  await a.start();
  await b.start();
  await waitFor(() => b.vault.text('plans/old.md') === 'line one\nline two\n', 'synced');
  await sleep(300);
  await b.stop();

  await a.vault.userRename('plans/old.md', 'plans/new.md'); // A renames while B is away
  await waitFor(() => a.vault.text('plans/new.md') === 'line one\nline two\n', 'renamed on A');
  await sleep(300);

  await b.start(false); // B comes back offline and edits the old note
  await b.vault.userWrite('plans/old.md', 'line one\nline two\nline three from B\n');
  await sleep(300);
  await b.connect();

  await waitFor(
    () => a.vault.text('plans/new.md') === 'line one\nline two\nline three from B\n' && b.vault.text('plans/new.md') === 'line one\nline two\nline three from B\n',
    'edit followed the rename',
  );
  await waitFor(() => !a.vault.files.has('plans/old.md') && !b.vault.files.has('plans/old.md'), 'old note gone');
  assert.deepEqual(conflicts(a).concat(conflicts(b)), []);
  await stopAll([a, b]);
});
