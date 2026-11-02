import { test } from 'node:test';
import assert from 'node:assert/strict';
import { History, whenText, type HistoryStore } from '../src/history';

const memory = (): HistoryStore & { files: Map<string, string> } => {
  const files = new Map<string, string>();
  return { files, read: async (k) => files.get(k) ?? null, write: async (k, d) => void files.set(k, d) };
};

test('keeps the newest versions first and skips identical text', async () => {
  let t = 1_000_000;
  const h = new History(memory(), () => (t += 1000));
  await h.record('a.md', 'one', 'remote');
  await h.record('a.md', 'one', 'remote'); // same text: not stored twice
  await h.record('a.md', 'two', 'merge');
  const v = await h.list('a.md');
  assert.deepEqual(v.map((x) => x.text), ['two', 'one']);
  assert.deepEqual(v.map((x) => x.reason), ['merge', 'remote']);
  assert.deepEqual(await h.list('other.md'), []);
});

test('saves made while working are spaced out, other reasons are always kept', async () => {
  let t = 5_000_000;
  const h = new History(memory(), () => t);
  await h.record('a.md', 'v1', 'auto');
  t += 30_000;
  await h.record('a.md', 'v2', 'auto'); // too soon after the last one
  await h.record('a.md', 'v3', 'remote'); // always kept
  t += 3 * 60_000;
  await h.record('a.md', 'v4', 'auto');
  assert.deepEqual((await h.list('a.md')).map((x) => x.text), ['v4', 'v3', 'v1']);
});

test('only the newest few versions are kept, and huge notes are skipped', async () => {
  let t = 0;
  const h = new History(memory(), () => (t += 1), 3, 100);
  for (let i = 0; i < 6; i++) await h.record('a.md', 'text ' + i, 'remote');
  assert.deepEqual((await h.list('a.md')).map((x) => x.text), ['text 5', 'text 4', 'text 3']);
  await h.record('big.md', 'x'.repeat(101), 'remote');
  assert.deepEqual(await h.list('big.md'), []);
});

test('quick saves of one note do not overwrite each other', async () => {
  let t = 0;
  const h = new History(memory(), () => (t += 1));
  await Promise.all(['a', 'b', 'c', 'd'].map((x) => h.record('n.md', x, 'remote')));
  assert.equal((await h.list('n.md')).length, 4);
});

test('a damaged history file starts over instead of crashing', async () => {
  const store = memory();
  const h = new History(store);
  await h.record('a.md', 'one', 'remote');
  for (const k of store.files.keys()) store.files.set(k, '{not json');
  assert.deepEqual(await h.list('a.md'), []);
  await h.record('a.md', 'two', 'remote');
  assert.deepEqual((await h.list('a.md')).map((x) => x.text), ['two']);
});

test('friendly time text', () => {
  const now = 10 * 86_400_000;
  assert.equal(whenText(now - 10_000, now), 'just now');
  assert.equal(whenText(now - 5 * 60_000, now), '5 min ago');
  assert.equal(whenText(now - 3 * 3_600_000, now), '3 h ago');
  assert.equal(whenText(now - 86_400_000, now), 'yesterday');
  assert.equal(whenText(now - 4 * 86_400_000, now), '4 days ago');
});
