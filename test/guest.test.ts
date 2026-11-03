// Host and guest: the party leader's vault leads. A vault that joins keeps the notes it already
// had private, so it can never push them into the host's vault, and the host's version wins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, Device, waitFor, sleep, buf, same } from './helpers';

const photo = buf(1, 2, 3, 4, 5);

const setup = () => {
  const hub = new Hub();
  const host = new Device('Host', hub);
  const guest = new Device('Guest', hub, { localOnly: ['private.md', 'photo.png', 'collision.md'] });
  host.vault.files.set('host.md', 'the host leads');
  host.vault.files.set('collision.md', 'the host version');
  guest.vault.files.set('private.md', 'my old private notes');
  guest.vault.files.set('photo.png', photo);
  guest.vault.files.set('collision.md', 'the guest version');
  return { host, guest };
};
const conflictsOf = (d: Device) => d.vault.names().filter((n) => n.includes('(conflict'));

test('a joining vault gets the host\'s notes and keeps its own old notes private', async () => {
  const { host, guest } = setup();
  await host.start();
  await guest.start();
  await waitFor(() => guest.vault.text('host.md') === 'the host leads', 'guest receives host notes', 8000);
  await sleep(1200); // plenty of time for anything the guest might wrongly share

  assert.equal(host.vault.files.has('private.md'), false, 'old note stays private');
  assert.equal(host.vault.files.has('photo.png'), false, 'old picture stays private');
  assert.equal(guest.vault.text('private.md'), 'my old private notes', 'guest keeps its own file');
  assert.deepEqual(conflictsOf(host), [], 'the host gets no conflict copies');
  await Promise.all([host.stop(), guest.stop()]);
});

test('when both have the same note, the host\'s version wins and the guest\'s is kept privately', async () => {
  const { host, guest } = setup();
  await host.start();
  await guest.start();
  await waitFor(() => guest.vault.text('collision.md') === 'the host version', 'host version arrives', 8000);
  await sleep(800);

  assert.equal(host.vault.text('collision.md'), 'the host version', 'the host is not changed');
  const copy = conflictsOf(guest);
  assert.equal(copy.length, 1, 'the guest keeps its version as a copy');
  assert.equal(guest.vault.text(copy[0]), 'the guest version');
  assert.deepEqual(conflictsOf(host), [], 'and the copy is not shared');
  assert.ok(guest.privateFiles.includes(copy[0]), 'the copy is private');
  assert.ok(!guest.privateFiles.includes('collision.md'), 'collision.md is now a shared note');
  await Promise.all([host.stop(), guest.stop()]);
});

test('after joining, a guest can edit the host\'s notes and add new ones', async () => {
  const { host, guest } = setup();
  await host.start();
  await guest.start();
  await waitFor(() => guest.vault.text('host.md') === 'the host leads', 'synced', 8000);
  await sleep(300);

  await guest.vault.userWrite('host.md', 'the host leads\nand a guest helped\n');
  await guest.vault.userWrite('from-guest.md', 'made after joining');
  await waitFor(
    () => host.vault.text('host.md') === 'the host leads\nand a guest helped\n' && host.vault.text('from-guest.md') === 'made after joining',
    'host receives the guest\'s edits',
    8000,
  );
  await host.vault.userWrite('host.md', 'the host leads\nand a guest helped\nthanks!\n');
  await waitFor(() => guest.vault.text('host.md') === 'the host leads\nand a guest helped\nthanks!\n', 'and the other way', 8000);
  await Promise.all([host.stop(), guest.stop()]);
});

test('private notes stay private when they are edited, renamed or deleted', async () => {
  const { host, guest } = setup();
  await host.start();
  await guest.start();
  await waitFor(() => guest.vault.text('host.md') === 'the host leads', 'synced', 8000);
  await sleep(300);

  await guest.vault.userWrite('private.md', 'edited private notes');
  await guest.vault.userRename('private.md', 'renamed private.md');
  await guest.vault.userDelete('photo.png');
  await sleep(1500);

  assert.deepEqual(host.vault.names().filter((n) => n.includes('private') || n.includes('photo')), [], 'nothing leaked');
  assert.ok(guest.privateFiles.includes('renamed private.md'), 'the new name is private too');
  assert.ok(!guest.privateFiles.includes('private.md') && !guest.privateFiles.includes('photo.png'), 'old names are forgotten');
  await Promise.all([host.stop(), guest.stop()]);
});

test('the guest\'s private list survives a restart, so nothing leaks later', async () => {
  const { host, guest } = setup();
  await host.start();
  await guest.start();
  await waitFor(() => guest.vault.text('host.md') === 'the host leads', 'synced', 8000);
  await sleep(300);
  await guest.stop();

  // the plugin passes the saved list back in when it starts again
  const again = new Device('Guest', (host as unknown as { hub: Hub }).hub, { localOnly: guest.privateFiles });
  again.vault.files = guest.vault.files;
  again.state = guest.state;
  again.meta = guest.meta;
  await again.start();
  await sleep(1800);

  assert.equal(host.vault.files.has('private.md'), false);
  assert.equal(host.vault.files.has('photo.png'), false);
  assert.equal(same(host.vault.files.get('photo.png') as ArrayBuffer | undefined, photo), false);
  await Promise.all([host.stop(), again.stop()]);
});
