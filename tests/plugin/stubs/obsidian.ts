/**
 * Stand-in for the `obsidian` module in plugin unit tests.
 *
 * scripts/test.mjs aliases `obsidian` to this file, so src/ modules import it
 * unchanged. It covers the API surface src/ imports, with behaviour only
 * where a test can observe it: notices are recorded, requestUrl goes through
 * a replaceable handler (see ./requestUrl.ts), Platform is a plain mutable
 * object. It is not a DOM: views that render need their own element fakes.
 *
 * Tests reach the extras (notices, setRequestUrlHandler, ...) by importing
 * "./stubs/obsidian" directly; it resolves to the same module instance as
 * `obsidian` inside the bundle.
 */

// Obsidian always runs in a window; several src/ modules call window.setTimeout.
if (typeof (globalThis as any).window === "undefined") {
  (globalThis as any).window = globalThis;
}

export type App = any;
export type Editor = any;
export type Vault = any;
export type RequestUrlParam = {
  url: string;
  method?: string;
  contentType?: string;
  body?: string | ArrayBuffer;
  headers?: Record<string, string>;
  throw?: boolean;
};
export type RequestUrlResponse = {
  status: number;
  headers: Record<string, string>;
  text: string;
  json: any;
  arrayBuffer: ArrayBuffer;
};

// ----------------------------------------------------------------- platform

/** Desktop Linux by default. Tests flip fields directly and restore them. */
export const Platform = {
  isDesktop: true,
  isDesktopApp: true,
  isMobile: false,
  isMobileApp: false,
  isIosApp: false,
  isAndroidApp: false,
  isPhone: false,
  isTablet: false,
  isMacOS: false,
  isWin: false,
  isLinux: true,
  isSafari: false,
};

// ------------------------------------------------------------------ notices

export const notices: string[] = [];

export function resetNotices(): void {
  notices.length = 0;
}

export class Notice {
  message: string;
  constructor(message: string | DocumentFragment, _duration?: number) {
    this.message = String(message);
    notices.push(this.message);
  }
  setMessage(message: string | DocumentFragment): this {
    this.message = String(message);
    return this;
  }
  hide(): void {}
}

// --------------------------------------------------------------- requestUrl

type RequestUrlHandler = (request: RequestUrlParam) => Promise<RequestUrlResponse>;

const offline: RequestUrlHandler = async (request) => {
  throw new Error(`requestUrl stub: network disabled (${request.method ?? "GET"} ${request.url})`);
};
let requestUrlHandler: RequestUrlHandler = offline;

/** Route requestUrl calls to `handler`; `null` restores the offline default. */
export function setRequestUrlHandler(handler: RequestUrlHandler | null): void {
  requestUrlHandler = handler ?? offline;
}

export function requestUrl(request: RequestUrlParam | string): Promise<RequestUrlResponse> {
  return requestUrlHandler(typeof request === "string" ? { url: request } : request);
}

// ------------------------------------------------------------- misc helpers

export const icons = new Map<string, string>();

export function addIcon(id: string, svg: string): void {
  icons.set(id, svg);
}

export function setIcon(_el: unknown, _icon: string): void {}
export function setTooltip(_el: unknown, _tooltip: string, _options?: unknown): void {}

export function normalizePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/|\/$/g, "");
}

// ------------------------------------------------------------------- vault

export class TAbstractFile {
  path: string;
  name: string;
  parent: TFolder | null = null;
  constructor(path: string) {
    this.path = path;
    this.name = path.split("/").pop() ?? path;
  }
}

export class TFile extends TAbstractFile {
  basename: string;
  extension: string;
  stat = { ctime: 0, mtime: 0, size: 0 };
  constructor(path: string) {
    super(path);
    const dot = this.name.lastIndexOf(".");
    this.basename = dot > 0 ? this.name.slice(0, dot) : this.name;
    this.extension = dot > 0 ? this.name.slice(dot + 1) : "";
  }
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
}

export class FileSystemAdapter {
  getBasePath(): string {
    return "";
  }
}

// -------------------------------------------------------------- components

export class Events {
  on(_name: string, _callback: (...args: any[]) => any): { name: string } {
    return { name: _name };
  }
  off(): void {}
  trigger(): void {}
}

export class Component {
  private children: Component[] = [];
  private cleanups: (() => void)[] = [];
  load(): void {
    this.onload();
    for (const child of this.children) child.load();
  }
  unload(): void {
    for (const child of this.children) child.unload();
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.onunload();
  }
  onload(): void {}
  onunload(): void {}
  addChild<T extends Component>(child: T): T {
    this.children.push(child);
    return child;
  }
  removeChild<T extends Component>(child: T): T {
    this.children = this.children.filter((c) => c !== child);
    return child;
  }
  register(cleanup: () => void): void {
    this.cleanups.push(cleanup);
  }
  registerEvent(_ref: unknown): void {}
  registerDomEvent(_el: unknown, _type: string, _cb: unknown): void {}
  registerInterval(id: number): number {
    return id;
  }
}

export class Plugin extends Component {
  app: App;
  manifest: any;
  private data: unknown = null;
  constructor(app?: App, manifest?: any) {
    super();
    this.app = app;
    this.manifest = manifest ?? { id: "darjeeling", version: "0.0.0" };
  }
  async loadData(): Promise<any> {
    return this.data;
  }
  async saveData(data: unknown): Promise<void> {
    this.data = data;
  }
  addCommand(command: any): any {
    return command;
  }
  addRibbonIcon(_icon: string, _title: string, _callback: unknown): any {
    return {};
  }
  addSettingTab(_tab: unknown): void {}
  registerView(_type: string, _factory: unknown): void {}
  registerObsidianProtocolHandler(_action: string, _handler: unknown): void {}
}

export class WorkspaceLeaf {
  view: any = null;
}

export class View extends Component {
  app: App;
  leaf: WorkspaceLeaf;
  containerEl: any = { children: [] };
  constructor(leaf: WorkspaceLeaf) {
    super();
    this.leaf = leaf;
    this.app = (leaf as any)?.app;
  }
}

export class ItemView extends View {}

export class MarkdownView extends View {
  file: TFile | null = null;
  editor: any = null;
  getMode(): string {
    return "source";
  }
}

export const MarkdownRenderer = {
  async render(_app: App, _markdown: string, _el: unknown, _sourcePath: string, _component: unknown) {},
  async renderMarkdown(_markdown: string, _el: unknown, _sourcePath: string, _component: unknown) {},
};

// ------------------------------------------------------------ modals, menus

export class Modal {
  app: App;
  contentEl: any = {};
  modalEl: any = {};
  titleEl: any = {};
  scope = { register() {} };
  constructor(app: App) {
    this.app = app;
  }
  open(): void {
    this.onOpen();
  }
  close(): void {
    this.onClose();
  }
  onOpen(): void {}
  onClose(): void {}
}

export class SuggestModal<T> extends Modal {
  setPlaceholder(_text: string): void {}
  getSuggestions(_query: string): T[] | Promise<T[]> {
    return [];
  }
  renderSuggestion(_item: T, _el: unknown): void {}
  onChooseSuggestion(_item: T, _evt: unknown): void {}
}

export class MenuItem {
  title = "";
  checked = false;
  disabled = false;
  callback: (() => unknown) | null = null;
  setTitle(title: string): this {
    this.title = title;
    return this;
  }
  setIcon(_icon: string): this {
    return this;
  }
  setChecked(checked: boolean): this {
    this.checked = checked;
    return this;
  }
  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    return this;
  }
  onClick(callback: () => unknown): this {
    this.callback = callback;
    return this;
  }
}

/** Menus record their items so a test can find one by title and click it. */
export class Menu {
  items: MenuItem[] = [];
  addItem(build: (item: MenuItem) => unknown): this {
    const item = new MenuItem();
    build(item);
    this.items.push(item);
    return this;
  }
  addSeparator(): this {
    return this;
  }
  showAtMouseEvent(_event: unknown): this {
    return this;
  }
  showAtPosition(_position: unknown): this {
    return this;
  }
}

// --------------------------------------------------------------- settings

export class PluginSettingTab {
  app: App;
  plugin: any;
  containerEl: any = {};
  constructor(app: App, plugin: any) {
    this.app = app;
    this.plugin = plugin;
  }
  display(): void {}
  hide(): void {}
}

/**
 * Every component a Setting built, newest last, so a test can drive a text
 * field: `c.fire("change", value)` runs its onChange handler and
 * `c.inputEl.dispatch("blur")` runs its DOM listeners. Reset with
 * resetSettingComponents().
 */
export const settingComponents: any[] = [];
/** Text of every note a Setting added under its description (createDiv / createEl). */
export const settingNotes: string[] = [];

export function resetSettingComponents(): void {
  settingComponents.length = 0;
  settingNotes.length = 0;
}

function noteEl(): any {
  const el: any = {
    createDiv: (o?: { text?: string }) => {
      if (o?.text) settingNotes.push(o.text);
      return noteEl();
    },
    createEl: (_tag: string, o?: { text?: string }) => {
      if (o?.text) settingNotes.push(o.text);
      return noteEl();
    },
    createSpan: (o?: { text?: string }) => {
      if (o?.text) settingNotes.push(o.text);
      return noteEl();
    },
    empty: () => {},
    remove: () => {},
    addClass: () => {},
    setText: () => {},
  };
  return el;
}

/** Chainable, inert. Component callbacks receive a chainable stand-in. */
export class Setting {
  settingEl: any = noteEl();
  infoEl: any = noteEl();
  nameEl: any = noteEl();
  descEl: any = noteEl();
  controlEl: any = noteEl();
  constructor(_containerEl: unknown) {}
  setName(_name: unknown): this {
    return this;
  }
  setDesc(_desc: unknown): this {
    return this;
  }
  setHeading(): this {
    return this;
  }
  setClass(_cls: string): this {
    return this;
  }
  setDisabled(_disabled: boolean): this {
    return this;
  }
  addText(build: (c: any) => unknown): this {
    return this.add(build);
  }
  addTextArea(build: (c: any) => unknown): this {
    return this.add(build);
  }
  addToggle(build: (c: any) => unknown): this {
    return this.add(build);
  }
  addDropdown(build: (c: any) => unknown): this {
    return this.add(build);
  }
  addButton(build: (c: any) => unknown): this {
    return this.add(build);
  }
  addExtraButton(build: (c: any) => unknown): this {
    return this.add(build);
  }
  addSlider(build: (c: any) => unknown): this {
    return this.add(build);
  }
  private add(build: (c: any) => unknown): this {
    const c = chainable();
    settingComponents.push(c);
    build(c);
    return this;
  }
}

function fakeInputEl(): any {
  const listeners = new Map<string, Array<() => unknown>>();
  return {
    addClass: () => {},
    addEventListener: (type: string, fn: () => unknown) => {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    dispatch: (type: string) => {
      for (const fn of listeners.get(type) ?? []) fn();
    },
  };
}

function chainable(): any {
  const handlers: Record<string, (value: any) => unknown> = {};
  const target: any = {
    inputEl: fakeInputEl(),
    selectEl: {},
    buttonEl: {},
    toggleEl: {},
    /** Run the handler registered with onChange / onClick. */
    fire: (event: string, value?: unknown) => handlers[event]?.(value),
  };
  target.onChange = (fn: (value: any) => unknown) => {
    handlers.change = fn;
    return proxy;
  };
  target.onClick = (fn: (value: any) => unknown) => {
    handlers.click = fn;
    return proxy;
  };
  const proxy: any = new Proxy(target, {
    get(obj, key) {
      if (key in obj) return obj[key];
      // Not a thenable, and no coercion hooks: only method names chain.
      if (typeof key === "symbol" || key === "then") return undefined;
      return () => proxy;
    },
  });
  return proxy;
}
