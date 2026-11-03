import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { CmBinder } from '../../src/cm-binder';

function makeSide(name: string, initial: string) {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  awareness.setLocalStateField('user', { name, color: name === 'A' ? '#e5484d' : '#0091ff', colorLight: '#00000022' });
  const files = doc.getMap<Y.Text>('files');
  const bound: Record<string, boolean> = {};
  const reconciles: string[] = [];
  const host = {
    getAwareness: () => awareness,
    getText: (p: string) => files.get(p) ?? null,
    setBound: (p: string, b: boolean) => (bound[p] = b),
    reconcile: (p: string) => reconciles.push(p),
    log: (m: string) => ((window as any).logs ||= []).push(name + ': ' + m),
  };
  const binder = new CmBinder(host);
  const parent = document.createElement('div');
  parent.id = 'ed' + name;
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc: initial, extensions: [history(), keymap.of([...defaultKeymap, ...historyKeymap]), binder.extension] }),
  });
  return { doc, awareness, files, binder, view, bound, reconciles };
}

function link(a: ReturnType<typeof makeSide>, b: ReturnType<typeof makeSide>) {
  const wire = (x: typeof a, y: typeof a) => {
    x.doc.on('update', (u: Uint8Array, origin: unknown) => {
      if (origin !== 'net') setTimeout(() => Y.applyUpdate(y.doc, u, 'net'), 0);
    });
    x.awareness.on('update', ({ added, updated, removed }: any, origin: unknown) => {
      if (origin === 'net') return;
      const u = encodeAwarenessUpdate(x.awareness, added.concat(updated, removed));
      setTimeout(() => applyAwarenessUpdate(y.awareness, u, 'net'), 0);
    });
  };
  wire(a, b);
  wire(b, a);
}

(window as any).Y = Y;
(window as any).setup = (initial: string) => {
  const A = makeSide('A', initial);
  const B = makeSide('B', initial);
  // the shared text exists on A first, then travels to B
  A.doc.transact(() => A.files.set('n.md', new Y.Text(initial)));
  Y.applyUpdate(B.doc, Y.encodeStateAsUpdate(A.doc), 'net');
  link(A, B);
  const open = (s: typeof A, path = 'n.md') => s.binder.tick([{ view: s.view, path }]);
  (window as any).S = { A, B, open };
  open(A);
  open(B);
  return { aBound: A.binder.isBound(A.view), bBound: B.binder.isBound(B.view) };
};
