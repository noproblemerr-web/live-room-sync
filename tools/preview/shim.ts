// A tiny stand-in for Obsidian's UI classes, so the plugin's real panel and dialogs can be
// drawn in a normal browser page (see tools/preview/README.md). It is only for previews.

type Opts = { cls?: string | string[]; text?: string; attr?: Record<string, string>; type?: string; placeholder?: string };

const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
proto.createEl = function (this: HTMLElement, tag: string, o: Opts = {}) {
  const el = document.createElement(tag) as HTMLElement & { type?: string; placeholder?: string };
  const cls = Array.isArray(o.cls) ? o.cls : o.cls ? o.cls.split(' ') : [];
  cls.forEach((c) => el.classList.add(c));
  if (o.text) el.textContent = o.text;
  if (o.type) el.setAttribute('type', o.type);
  if (o.placeholder) el.setAttribute('placeholder', o.placeholder);
  for (const [k, v] of Object.entries(o.attr ?? {})) el.setAttribute(k, v);
  this.appendChild(el);
  return el;
};
proto.createDiv = function (this: HTMLElement, o?: Opts) {
  return (this as unknown as { createEl(t: string, o?: Opts): HTMLElement }).createEl('div', o);
};
proto.createSpan = function (this: HTMLElement, o?: Opts) {
  return (this as unknown as { createEl(t: string, o?: Opts): HTMLElement }).createEl('span', o);
};
proto.empty = function (this: HTMLElement) {
  this.replaceChildren();
};
proto.addClass = function (this: HTMLElement, ...c: string[]) {
  this.classList.add(...c);
};
proto.removeClass = function (this: HTMLElement, ...c: string[]) {
  this.classList.remove(...c);
};
proto.setText = function (this: HTMLElement, t: string) {
  this.textContent = t;
};
proto.setAttr = function (this: HTMLElement, k: string, v: string) {
  this.setAttribute(k, v);
};
proto.setCssProps = function (this: HTMLElement, props: Record<string, string>) {
  for (const [k, v] of Object.entries(props)) this.style.setProperty(k, v);
};

export class WorkspaceLeaf {}
export class App {}
export class Notice {
  constructor(public message: string) {}
}
export function setIcon(el: HTMLElement, name: string) {
  el.textContent = name === 'pencil' ? '✎' : name === 'x' ? '✕' : '•';
}

export class ItemView {
  contentEl = document.createElement('div');
  constructor(public leaf: unknown) {
    this.contentEl.classList.add('view-content');
  }
}

export class Modal {
  modalEl = document.createElement('div');
  contentEl = document.createElement('div');
  constructor(public app: unknown) {
    this.modalEl.classList.add('modal');
    this.contentEl.classList.add('modal-content');
    this.modalEl.appendChild(this.contentEl);
  }
  onOpen(): void {}
  onClose(): void {}
  open() {
    const host = document.getElementById('modal-host');
    host?.replaceChildren(this.modalEl);
    this.onOpen();
  }
  close() {
    this.onClose();
    this.modalEl.remove();
  }
}

export class PluginSettingTab {
  containerEl = document.createElement('div');
  constructor(public app: unknown, public plugin: unknown) {}
}

class Button {
  buttonEl = document.createElement('button');
  setButtonText(t: string) {
    this.buttonEl.textContent = t;
    return this;
  }
  setCta() {
    this.buttonEl.classList.add('mod-cta');
    return this;
  }
  onClick(cb: () => void) {
    this.buttonEl.onclick = cb;
    return this;
  }
}

export class Setting {
  private row: HTMLElement;
  private controls: HTMLElement;
  constructor(parent: HTMLElement) {
    this.row = parent.appendChild(document.createElement('div'));
    this.row.className = 'setting-item';
    this.controls = this.row.appendChild(document.createElement('div'));
  }
  setName(n: string) {
    this.row.prepend(Object.assign(document.createElement('div'), { textContent: n }));
    return this;
  }
  setDesc(d: string) {
    this.row.appendChild(Object.assign(document.createElement('div'), { textContent: d }));
    return this;
  }
  setHeading() {
    return this;
  }
  addButton(cb: (b: Button) => void) {
    const b = new Button();
    cb(b);
    this.controls.appendChild(b.buttonEl);
    return this;
  }
}
