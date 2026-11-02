const { chromium } = require('playwright');
const fs = require('fs');
const assert = require('assert');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.setContent('<html><body></body></html>');
  await page.addScriptTag({ content: fs.readFileSync(__dirname + '/out.js', 'utf8') });
  const txt = (side) => page.evaluate((s) => window.S[s].view.state.doc.toString(), side);
  const ytxt = (side) => page.evaluate((s) => window.S[s].files.get('n.md').toString(), side);
  const results = [];
  const check = async (name, fn) => {
    try { await fn(); results.push('ok   ' + name); } catch (e) { results.push('FAIL ' + name + ' :: ' + e.message.split('\n')[0]); }
  };

  const r = await page.evaluate(() => window.setup('hello world'));
  await check('both editors attach when text matches', async () => assert.deepStrictEqual(r, { aBound: true, bBound: true }));

  // real typing in A
  await page.click('#edA .cm-content');
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' from A');
  await sleep(100);
  await check('typing in A shows in B', async () => assert.strictEqual(await txt('B'), 'hello world from A'));

  await page.click('#edB .cm-content');
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('B: ');
  await sleep(100);
  await check('typing in B shows in A', async () => assert.strictEqual(await txt('A'), 'B: hello world from A'));

  // simultaneous edits in both without waiting
  await page.evaluate(() => {
    const { A, B } = window.S;
    A.view.dispatch({ changes: { from: A.view.state.doc.length, insert: ' [a]' } });
    B.view.dispatch({ changes: { from: 0, insert: '[b] ' } });
  });
  await sleep(150);
  await check('simultaneous edits converge', async () => {
    const a = await txt('A'), b = await txt('B');
    assert.strictEqual(a, b);
    assert.ok(a.includes('[a]') && a.includes('[b]'), a);
  });

  // undo only undoes my own change
  await page.click('#edA .cm-content');
  await page.keyboard.press('Control+z');
  await sleep(150);
  await check('undo in A removes only A typing, keeps B typing', async () => {
    const a = await txt('A'), b = await txt('B');
    assert.strictEqual(a, b);
    assert.ok(a.includes('[b]'), 'B text lost: ' + a);
    assert.ok(!a.includes('[a]'), 'A text still there: ' + a);
  });

  // remote cursor shows up
  await page.click('#edB .cm-content');
  await page.keyboard.type('x');
  await sleep(150);
  await check('A shows a cursor flag for B', async () => {
    const n = await page.evaluate(() => document.querySelectorAll('#edA .cm-ySelectionCaret').length);
    assert.ok(n >= 1, 'carets: ' + n);
  });
  await check('caret label carries the device name', async () => {
    const t = await page.evaluate(() => document.querySelector('#edA .cm-ySelectionInfo')?.textContent);
    assert.strictEqual(t, 'B');
  });

  // watchdog: sneak a change into the editor that bypasses Yjs -> must let go
  await page.evaluate(() => {
    const { A } = window.S;
    A.view.dispatch({ changes: { from: 0, insert: 'ROGUE ' }, annotations: [] });
    window.S.rogue = A.view.state.doc.toString();
  });
  await sleep(50);
  const stillSame = await page.evaluate(() => window.S.A.binder.isBound(window.S.A.view));
  await check('(sanity) rogue change normally flows to Yjs, binder stays', async () => assert.strictEqual(stillSame, true));

  // desync: change ytext in a way the editor cannot follow -> detach it via unmounting the facet
  await page.evaluate(() => {
    const { A } = window.S;
    // simulate Obsidian resetting the editor state (new file loaded into same view)
    A.view.setState(A.view.state.constructor.create({ doc: 'totally different file', extensions: [A.binder.extension] }));
  });
  await page.evaluate(() => window.S.open(window.S.A));
  await check('editor reset by app => binder lets go', async () => {
    assert.strictEqual(await page.evaluate(() => window.S.A.binder.isBound(window.S.A.view)), false);
    assert.strictEqual(await page.evaluate(() => window.S.A.bound['n.md']), false);
  });
  await check('text of the new file is not pushed into the shared note', async () => {
    assert.ok(!(await ytxt('B')).includes('totally different'));
  });
  await check('does not rebind to a note whose text differs; asks for a file sync', async () => {
    await page.evaluate(() => window.S.open(window.S.A));
    assert.strictEqual(await page.evaluate(() => window.S.A.binder.isBound(window.S.A.view)), false);
  });

  // editor closes
  await page.evaluate(() => window.S.B.binder.tick([]));
  await check('closing the editor releases the file', async () => {
    assert.strictEqual(await page.evaluate(() => window.S.B.bound['n.md']), false);
  });

  // after the editor shows the matching text again it attaches again (after quarantine -> use fresh path)
  await page.evaluate(() => {
    const { B } = window.S;
    B.doc.transact(() => B.files.set('m.md', new window.Y.Text('second note')));
    B.view.dispatch({ changes: { from: 0, to: B.view.state.doc.length, insert: 'second note' } });
    B.binder.tick([{ view: B.view, path: 'm.md' }]);
  });
  await check('attaches to another note when texts match', async () => {
    assert.strictEqual(await page.evaluate(() => window.S.B.binder.isBound(window.S.B.view)), true);
  });

  await check('no page errors', async () => assert.deepStrictEqual(errors, []));
  console.log(results.join('\n'));
  console.log((await page.evaluate(() => window.logs || [])).join('\n'));
  await browser.close();
  process.exit(results.some((x) => x.startsWith('FAIL')) ? 1 : 0);
})();
