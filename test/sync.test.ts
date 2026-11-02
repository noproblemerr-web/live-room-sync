import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, Device, waitFor, sleep, buf, same } from './helpers';

const mk = (n = 2, o: ConstructorParameters<typeof Device>[2] = {}) => {
  const hub = new Hub();
  const devs = Array.from({ length: n }, (_, i) => new Device('dev' + i, hub, o));
  return { hub, devs };
};
const stopAll = async (devs: Device[]) => {
  for (const d of devs) await d.stop();
};
const conflicts = (d: Device) => d.vault.names().filter((n) => n.includes('(conflict'));

test('fresh device receives everything, folders included', async () => {
  const { devs } = mk(2);
  const [a, b] = devs;
  a.vault.files.set('one.md', '# one\nhello');
  a.vault.files.set('deep/dir/two.md', 'two');
  a.vault.files.set('pic.png', buf(1, 2, 3, 4));
  await a.start();
  await b.start();
  await waitFor(() => b.vault.text('one.md') === '# one\nhello' && b.vault.text('deep/dir/two.md') === 'two' && same(b.vault.files.get('pic.png') as ArrayBuffer, buf(1, 2, 3, 4)), 'b gets files');
  assert.deepEqual(conflicts(b), []);
  assert.deepEqual(b.vault.names(), a.vault.names());
  await stopAll(devs);
});

test('identical vaults on both sides: no duplicates, no conflicts', async () => {
  const { devs } = mk(2);
  const [a, b] = devs;
  for (const d of devs) {
    d.vault.files.set('same.md', 'same text');
    d.vault.files.set('x/y.md', 'why');
  }
  await a.start();
  await b.start();
  await sleep(1500);
  assert.equal(a.vault.text('same.md'), 'same text');
  assert.equal(b.vault.text('same.md'), 'same text');
  assert.deepEqual(conflicts(a), []);
  assert.deepEqual(conflicts(b), []);
  assert.equal(a.engine.getText('same.md')!.toString(), 'same text'); // not doubled
  await stopAll(devs);
});

test('same file, different text on first join: nothing lost', async () => {
  const { devs } = mk(2);
  const [a, b] = devs;
  a.vault.files.set('n.md', 'from A');
  b.vault.files.set('n.md', 'from B');
  await a.start();
  await b.start();
  await waitFor(() => a.vault.text('n.md') === b.vault.text('n.md') && conflicts(a).length + conflicts(b).length >= 1, 'converged with conflict copy');
  await sleep(800);
  const all = [...a.vault.names(), ...b.vault.names()];
  const texts = new Set([...a.vault.files.values(), ...b.vault.files.values()]);
  assert.ok(texts.has('from A') && texts.has('from B'), 'both texts survive');
  assert.equal(a.vault.text('n.md'), b.vault.text('n.md'));
  // both devices end with the same set of files
  assert.deepEqual(a.vault.names(), b.vault.names(), all.join());
  await stopAll(devs);
});

test('edits and new files flow both ways', async () => {
  const { devs } = mk(2);
  const [a, b] = devs;
  await a.start();
  await b.start();
  await sleep(700);
  await a.vault.userWrite('new.md', 'hi');
  await waitFor(() => b.vault.text('new.md') === 'hi', 'new file');
  await b.vault.userWrite('new.md', 'hi there');
  await waitFor(() => a.vault.text('new.md') === 'hi there', 'edit back');
  await a.vault.userWrite('new.md', 'hi there!\nsecond line');
  await waitFor(() => b.vault.text('new.md') === 'hi there!\nsecond line', 'edit forth');
  assert.deepEqual(conflicts(a).concat(conflicts(b)), []);
  await stopAll(devs);
});

test('edits in different places of one file are merged', async () => {
  const { hub, devs } = mk(2);
  const [a, b] = devs;
  a.vault.files.set('m.md', 'top\n\nmiddle\n\nbottom');
  await a.start();
  await b.start();
  await waitFor(() => b.vault.text('m.md') === 'top\n\nmiddle\n\nbottom', 'sync');
  hub.drop = true; // both edit while cut off
  await a.vault.userWrite('m.md', 'TOP\n\nmiddle\n\nbottom');
  await b.vault.userWrite('m.md', 'top\n\nmiddle\n\nBOTTOM');
  await sleep(300);
  hub.drop = false;
  // nudge: a new update from each side makes them exchange state
  await a.provider.transport.send('sv', (await import('yjs')).encodeStateVector(a.engine.doc));
  await b.provider.transport.send('sv', (await import('yjs')).encodeStateVector(b.engine.doc));
  await waitFor(() => a.vault.text('m.md') === 'TOP\n\nmiddle\n\nBOTTOM' && b.vault.text('m.md') === 'TOP\n\nmiddle\n\nBOTTOM', 'merged');
  assert.deepEqual(conflicts(a).concat(conflicts(b)), []);
  await stopAll(devs);
});

test('offline edits are kept and merged after restart', async () => {
  const { devs } = mk(2);
  const [a, b] = devs;
  a.vault.files.set('o.md', 'line1\nline2\nline3');
  await a.start();
  await b.start();
  await waitFor(() => b.vault.text('o.md') === 'line1\nline2\nline3', 'sync');
  await sleep(300);
  await b.stop();
  await a.vault.userWrite('o.md', 'LINE1\nline2\nline3');
  await a.vault.userWrite('a-only.md', 'made while b was away');
  await sleep(200);
  b.vault.files.set('o.md', 'line1\nline2\nLINE3'); // edited while Obsidian was closed
  b.vault.files.set('b-only.md', 'made on b');
  await b.start();
  await waitFor(
    () =>
      a.vault.text('o.md') === 'LINE1\nline2\nLINE3' &&
      b.vault.text('o.md') === 'LINE1\nline2\nLINE3' &&
      b.vault.text('a-only.md') === 'made while b was away' &&
      a.vault.text('b-only.md') === 'made on b',
    'everything merged',
  );
  assert.deepEqual(conflicts(a).concat(conflicts(b)), []);
  await stopAll(devs);
});

test('delete and rename travel; a restart does not bring files back', async () => {
  const { devs } = mk(2);
  const [a, b] = devs;
  a.vault.files.set('gone.md', 'bye');
  a.vault.files.set('old.md', 'moved');
  await a.start();
  await b.start();
  await waitFor(() => b.vault.text('gone.md') === 'bye' && b.vault.text('old.md') === 'moved', 'sync');
  await sleep(300);
  await a.vault.userDelete('gone.md');
  await a.vault.userRename('old.md', 'folder/new.md');
  await waitFor(() => !b.vault.files.has('gone.md') && !b.vault.files.has('old.md') && b.vault.text('folder/new.md') === 'moved', 'applied');
  await b.stop();
  await a.stop();
  await a.start();
  await b.start();
  await sleep(1500);
  assert.deepEqual(a.vault.names(), ['folder/new.md']);
  assert.deepEqual(b.vault.names(), ['folder/new.md']);
  await stopAll(devs);
});

test('deleted elsewhere but edited here: the edit wins and comes back', async () => {
  const { devs } = mk(2);
  const [a, b] = devs;
  a.vault.files.set('k.md', 'v1');
  await a.start();
  await b.start();
  await waitFor(() => b.vault.text('k.md') === 'v1', 'sync');
  await sleep(300);
  await b.stop();
  await a.vault.userDelete('k.md');
  await sleep(200);
  b.vault.files.set('k.md', 'v1 + my new work');
  await b.start();
  await waitFor(() => a.vault.text('k.md') === 'v1 + my new work', 'resurrected on a');
  assert.equal(b.vault.text('k.md'), 'v1 + my new work');
  await stopAll(devs);
});

test('pictures: big-ish binary goes across, changed picture updates, delete follows', async () => {
  const { devs } = mk(2);
  const [a, b] = devs;
  const big = new Uint8Array(300_000).map((_, i) => (i * 7) % 251).buffer as ArrayBuffer;
  await a.start();
  await b.start();
  await sleep(700);
  await a.vault.userWrite('img/big.png', big);
  await waitFor(() => same(b.vault.files.get('img/big.png') as ArrayBuffer, big), 'blob arrives');
  const v2 = buf(9, 9, 9);
  await b.vault.userWrite('img/big.png', v2);
  await waitFor(() => same(a.vault.files.get('img/big.png') as ArrayBuffer, v2), 'update arrives');
  await a.vault.userDelete('img/big.png');
  await waitFor(() => !b.vault.files.has('img/big.png'), 'delete arrives');
  await stopAll(devs);
});

test('too-big attachment is skipped, not an error', async () => {
  const { devs } = mk(2);
  const [a, b] = devs;
  await a.start();
  await b.start();
  await sleep(700);
  await a.vault.userWrite('huge.bin', new Uint8Array(2_000_000).buffer as ArrayBuffer);
  await sleep(600);
  assert.ok(!b.vault.files.has('huge.bin'));
  assert.ok(!a.logs.some((l) => l.startsWith('error')));
  await stopAll(devs);
});

test('three devices converge, even when two cannot see each other', async () => {
  const hub = new Hub();
  const [a, b, c] = ['A', 'B', 'C'].map((n) => new Device(n, hub));
  await a.start(false);
  await b.start(false);
  await c.start(false);
  // a-b and b-c connected, a-c blocked: b relays
  for (const [x, y] of [[a, c]]) hub.blocked.add(`${x.name}`); // placeholder, set after ids exist
  await a.connect();
  await b.connect();
  await c.connect();
  hub.blocked.clear();
  // cut a<->c links manually
  const cut = (x: Device, y: Device) => {
    x.transport.link.delete(y.transport.selfId);
    y.transport.link.delete(x.transport.selfId);
    x.transport.onPeerLeave?.(y.transport.selfId);
    y.transport.onPeerLeave?.(x.transport.selfId);
  };
  await sleep(100);
  cut(a, c);
  await a.vault.userWrite('from-a.md', 'A says hi');
  await c.vault.userWrite('from-c.md', 'C says hi');
  await waitFor(() => c.vault.text('from-a.md') === 'A says hi' && a.vault.text('from-c.md') === 'C says hi' && b.vault.text('from-a.md') === 'A says hi', 'relayed');
  assert.deepEqual(a.vault.names(), c.vault.names());
  await stopAll([a, b, c]);
});

test('no endless back-and-forth after changes settle', async () => {
  const { devs } = mk(2);
  const [a, b] = devs;
  await a.start();
  await b.start();
  await sleep(700);
  for (let i = 0; i < 5; i++) await a.vault.userWrite(`f${i}.md`, 'x'.repeat(i + 1));
  await waitFor(() => b.vault.names().length === 5, 'files');
  await sleep(500);
  const w = a.vault.writes + b.vault.writes;
  const s = a.transport.sent + b.transport.sent;
  await sleep(1200);
  assert.equal(a.vault.writes + b.vault.writes, w, 'no more disk writes');
  assert.equal(a.transport.sent + b.transport.sent, s, 'no more network chatter');
  await stopAll(devs);
});

test('windows line endings do not cause fights', async () => {
  const { devs } = mk(2);
  const [a, b] = devs;
  a.vault.files.set('crlf.md', 'a\r\nb\r\nc');
  await a.start();
  await b.start();
  await waitFor(() => b.vault.text('crlf.md') === 'a\nb\nc', 'normalized');
  await sleep(800);
  assert.deepEqual(conflicts(a).concat(conflicts(b)), []);
  await stopAll(devs);
});

test('config folder and hidden files are never shared', async () => {
  const { devs } = mk(2);
  const [a, b] = devs;
  a.vault.files.set('.obsidian/app.json', '{}');
  a.vault.files.set('.hidden/x.md', 'secret');
  a.vault.files.set('ok.md', 'fine');
  await a.start();
  await b.start();
  await waitFor(() => b.vault.text('ok.md') === 'fine', 'ok synced');
  await sleep(500);
  assert.deepEqual(b.vault.names(), ['ok.md']);
  await stopAll(devs);
});
