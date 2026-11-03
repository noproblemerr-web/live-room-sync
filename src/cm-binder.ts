import * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import { Compartment, Facet, Prec, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';

/** What the binder needs from the sync engine. Kept small so it can be tested alone. */
export interface BinderHost {
  getAwareness(): Awareness;
  getText(path: string): Y.Text | null;
  setBound(path: string, bound: boolean): void;
  /** ask the engine to make the file on disk and the shared text agree */
  reconcile(path: string): void;
  log?(msg: string): void;
}

interface Binding {
  id: number;
  path: string;
  ytext: Y.Text;
  undo: Y.UndoManager;
  strikes: number;
}

const marker = Facet.define<number, number>({ combine: (v) => v[v.length - 1] ?? 0 });

const QUARANTINE_MS = 60_000;

/**
 * Connects open editors to shared text, so typing shows up live on other devices.
 * It only attaches when the editor text is exactly the shared text, and it checks again and
 * again. If anything looks wrong it lets go and the normal file sync takes over.
 */
export class CmBinder {
  readonly compartment = new Compartment();
  /** Register this once with the editor (plugin.registerEditorExtension). */
  readonly extension: Extension = this.compartment.of([]);

  private bindings = new Map<EditorView, Binding>();
  private quarantine = new Map<string, number>();
  private nextId = 1;
  private tickNo = 0;

  constructor(
    private host: BinderHost,
    private now: () => number = () => Date.now(),
  ) {}

  /** Number of editors that are live right now. */
  count(): number {
    return this.bindings.size;
  }

  isBound(view: EditorView): boolean {
    return this.bindings.has(view);
  }

  /**
   * Call often. `open` lists every editor that is showing a note and which file it shows.
   * Editors that are not in the list any more are let go.
   */
  tick(open: { view: EditorView; path: string }[]): void {
    this.tickNo++;
    const alive = new Set(open.map((o) => o.view));
    for (const view of [...this.bindings.keys()]) if (!alive.has(view)) this.unbind(view);

    for (const { view, path } of open) {
      const b = this.bindings.get(view);
      if (b) {
        const h = this.healthy(view, b, path);
        if (h !== 'ok') this.unbind(view, h === 'differs');
        continue;
      }
      this.tryBind(view, path);
    }
  }

  unbindAll(): void {
    for (const view of [...this.bindings.keys()]) this.unbind(view);
  }

  private healthy(view: EditorView, b: Binding, path: string): 'ok' | 'gone' | 'differs' {
    if (b.path !== path) return 'gone'; // the editor now shows another file
    if (view.state.facet(marker) !== b.id) return 'gone'; // the editor was reset under us
    if (this.host.getText(path) !== b.ytext) return 'gone'; // the shared text was replaced or deleted
    const same = view.state.doc.length === b.ytext.length;
    const full = same && this.tickNo % 5 === 0 ? view.state.doc.toString() === b.ytext.toString() : same;
    if (full) {
      b.strikes = 0;
      return 'ok';
    }
    // one bad look can be a timing thing; two in a row is real
    return ++b.strikes < 2 ? 'ok' : 'differs';
  }

  private tryBind(view: EditorView, path: string): void {
    const until = this.quarantine.get(path);
    if (until !== undefined) {
      if (this.now() < until) return;
      this.quarantine.delete(path);
    }
    const ytext = this.host.getText(path);
    if (!ytext) return;
    if (view.state.doc.length !== ytext.length || view.state.doc.toString() !== ytext.toString()) {
      this.host.reconcile(path); // not the same yet: let file sync catch up first
      return;
    }
    const id = this.nextId++;
    const undo = new Y.UndoManager(ytext);
    this.host.setBound(path, true);
    try {
      view.dispatch({
        effects: this.compartment.reconfigure([
          marker.of(id),
          yCollab(ytext, this.host.getAwareness(), { undoManager: undo }),
          Prec.highest(keymap.of(yUndoManagerKeymap)),
        ]),
      });
    } catch (err) {
      undo.destroy();
      this.host.setBound(path, false);
      this.quarantine.set(path, this.now() + QUARANTINE_MS);
      this.host.log?.(`could not start live typing for ${path}: ${String(err)}`);
      return;
    }
    this.bindings.set(view, { id, path, ytext, undo, strikes: 0 });
  }

  private unbind(view: EditorView, penalty = false): void {
    const b = this.bindings.get(view);
    if (!b) return;
    this.bindings.delete(view);
    try {
      if (view.state.facet(marker) === b.id) view.dispatch({ effects: this.compartment.reconfigure([]) });
    } catch {
      /* the editor is already gone */
    }
    b.undo.destroy();
    // only release the file when no other editor still shows it live
    let still = false;
    for (const o of this.bindings.values()) if (o.path === b.path) still = true;
    if (!still) this.host.setBound(b.path, false);
    if (penalty) {
      this.quarantine.set(b.path, this.now() + QUARANTINE_MS);
      this.host.log?.(`live typing paused for ${b.path} (editor and shared text differed)`);
    }
  }
}

export { EditorView };
