/* A minimal DOM so CodeMirror and Obsidian DOM code can load under Node.
 * Test support only: never bundled, never deployed. */

function createStyle(): Record<string, unknown> {
  const style: Record<string, unknown> = {};
  style.setProperty = (name: string, value: unknown): void => {
    style[name] = String(value);
  };
  style.getPropertyValue = (name: string): string =>
    typeof style[name] === "string" ? (style[name] as string) : "";
  style.removeProperty = (name: string): void => {
    delete style[name];
  };
  return style;
}

export class ShimElement {
  tagName: string;
  nodeType: number;
  children: ShimElement[] = [];
  /** Plain property access plus the CSSStyleDeclaration methods code relies on. */
  style: Record<string, unknown> = createStyle();
  attributes: Record<string, unknown> = {};
  classes = new Set<string>();
  listeners = new Map<string, Array<(event: unknown) => void>>();
  parentNode: ShimElement | null = null;
  value = "";
  disabled = false;
  checked = false;
  id = "";
  private text = "";

  constructor(tag: string) {
    this.tagName = String(tag).toUpperCase();
    this.nodeType = String(tag).startsWith("#") ? 3 : 1;
  }

  get textContent(): string {
    if (this.children.length === 0) return this.text;
    return this.text + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.text = String(value);
    this.children = [];
  }

  get classList() {
    return {
      add: (...names: string[]) => names.forEach((name) => this.classes.add(name)),
      remove: (...names: string[]) => names.forEach((name) => this.classes.delete(name)),
      contains: (name: string) => this.classes.has(name),
      toggle: (name: string, force?: boolean) => {
        const next = force === undefined ? !this.classes.has(name) : Boolean(force);
        if (next) this.classes.add(name);
        else this.classes.delete(name);
        return next;
      }
    };
  }

  get className(): string {
    return [...this.classes].join(" ");
  }

  set className(value: string) {
    this.classes = new Set(
      String(value)
        .split(/\s+/)
        .filter((name) => name !== "")
    );
  }

  get firstChild(): ShimElement | null {
    return this.children[0] ?? null;
  }

  get parentElement(): ShimElement | null {
    return this.parentNode;
  }

  private childAt(position: number): ShimElement | null {
    const parent = this.parentNode;
    if (parent === null) return null;
    const index = parent.children.indexOf(this);
    if (index < 0) return null;
    return parent.children[index + position] ?? null;
  }

  get nextSibling(): ShimElement | null {
    return this.childAt(1);
  }

  get nextElementSibling(): ShimElement | null {
    let node = this.childAt(1);
    while (node !== null && node.nodeType !== 1) node = node.childAt(1);
    return node;
  }

  get previousElementSibling(): ShimElement | null {
    let node = this.childAt(-1);
    while (node !== null && node.nodeType !== 1) node = node.childAt(-1);
    return node;
  }

  /** Layout values tests can set; browsers compute them from CSS. */
  offsetTop = 0;
  scrollTop = 0;
  scrollHeight = 0;
  selectionStart = 0;
  selectionEnd = 0;

  get childNodes(): ShimElement[] {
    return this.children;
  }

  get lastChild(): ShimElement | null {
    return this.children[this.children.length - 1] ?? null;
  }

  addClass(...names: string[]): this {
    names.forEach((name) => this.classes.add(name));
    return this;
  }

  removeClass(...names: string[]): this {
    names.forEach((name) => this.classes.delete(name));
    return this;
  }

  toggleClass(names: string | string[], value?: boolean): this {
    for (const name of Array.isArray(names) ? names : [names]) this.classList.toggle(name, value);
    return this;
  }

  hasClass(name: string): boolean {
    return this.classes.has(name);
  }

  setAttr(name: string, value: unknown): this {
    this.attributes[name] = value;
    return this;
  }

  getAttr(name: string): unknown {
    return this.attributes[name] ?? null;
  }

  setAttribute(name: string, value: unknown): void {
    this.attributes[name] = value;
  }

  getAttribute(name: string): string | null {
    const value = this.attributes[name];
    return value === undefined ? null : String(value);
  }

  hasAttribute(name: string): boolean {
    return this.attributes[name] !== undefined;
  }

  removeAttribute(name: string): void {
    delete this.attributes[name];
  }

  setText(value: string): this {
    this.textContent = String(value);
    return this;
  }

  empty(): this {
    this.children = [];
    this.text = "";
    return this;
  }

  appendChild<T extends ShimElement>(node: T): T {
    const previous = node.parentNode;
    if (previous !== null) {
      const index = previous.children.indexOf(node);
      if (index >= 0) previous.children.splice(index, 1);
    }
    node.parentNode = this;
    this.children.push(node);
    return node;
  }

  insertBefore<T extends ShimElement>(node: T, reference: ShimElement | null): T {
    // Real DOM moves an existing node instead of duplicating it.
    const current = node.parentNode;
    if (current !== null) {
      const position = current.children.indexOf(node);
      if (position >= 0) current.children.splice(position, 1);
    }

    node.parentNode = this;
    const index = reference === null ? -1 : this.children.indexOf(reference);
    if (index < 0) this.children.push(node);
    else this.children.splice(index, 0, node);
    return node;
  }

  replaceWith(node: ShimElement): void {
    const parent = this.parentNode;
    if (parent === null) return;
    const index = parent.children.indexOf(this);
    if (index >= 0) parent.children[index] = node;
    node.parentNode = parent;
  }

  remove(): void {
    const parent = this.parentNode;
    if (parent === null) return;
    const index = parent.children.indexOf(this);
    if (index >= 0) parent.children.splice(index, 1);
    this.parentNode = null;
  }

  detach(): void {
    this.remove();
  }

  createEl(tag: string, options?: unknown): ShimElement {
    const element = new ShimElement(tag);
    applyOptions(element, options);
    return this.appendChild(element);
  }

  createDiv(options?: unknown): ShimElement {
    return this.createEl("div", options);
  }

  createSpan(options?: unknown): ShimElement {
    return this.createEl("span", options);
  }

  createSvg(tag: string, options?: unknown): ShimElement {
    return this.createEl(tag, options);
  }

  addEventListener(type: string, handler: (event: never) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(handler as (event: unknown) => void);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, handler: (event: never) => void): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((candidate) => candidate !== handler)
    );
  }

  dispatch(type: string, event: Record<string, unknown> = {}): void {
    for (const handler of this.listeners.get(type) ?? []) {
      handler({ preventDefault() {}, stopPropagation() {}, ...event });
    }
  }

  click(): void {
    // Browsers do not dispatch click on disabled controls.
    if (this.disabled) return;
    this.dispatch("click");
  }

  focus(): void {}
  blur(): void {}
  setSelectionRange(start = 0, end = start): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
  scrollIntoView(): void {}
  setPointerCapture(): void {}
  releasePointerCapture(): void {}

  querySelector(selector: string): ShimElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): ShimElement[] {
    const matches: ShimElement[] = [];
    const visit = (node: ShimElement): void => {
      for (const child of node.children) {
        if (child.nodeType === 1 && matchesSelector(child, selector)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  closest(selector: string): ShimElement | null {
    let node: ShimElement | null = this;
    while (node !== null) {
      if (node.nodeType === 1 && matchesSelector(node, selector)) return node;
      node = node.parentNode;
    }
    return null;
  }

  matches(selector: string): boolean {
    return matchesSelector(this, selector);
  }

  contains(node: ShimElement | null): boolean {
    if (node === null) return false;
    if (node === this) return true;
    return this.children.some((child) => child.contains(node));
  }

  /** Tests set this to simulate layout. */
  rect: { top: number; left: number; right: number; bottom: number; width: number; height: number } | null =
    null;

  getBoundingClientRect() {
    return this.rect ?? { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
  }

  getClientRects(): unknown[] {
    return [];
  }

  set innerHTML(value: string) {
    this.textContent = value;
  }

  get innerHTML(): string {
    return this.textContent;
  }
}

function matchesAttribute(node: ShimElement, token: string): boolean {
  const inner = token.slice(1, -1).trim();
  const equals = inner.indexOf("=");
  const name = (equals < 0 ? inner : inner.slice(0, equals)).trim();
  const stored = node.attributes[name];

  if (equals < 0) return stored !== undefined;
  const expected = inner
    .slice(equals + 1)
    .trim()
    .replace(/^["']/, "")
    .replace(/["']$/, "");
  return stored !== undefined && String(stored) === expected;
}

function matchesSimple(node: ShimElement, selector: string): boolean {
  const trimmed = selector.trim();
  if (trimmed === "") return false;
  const parsed = trimmed.match(/^([a-zA-Z][a-zA-Z0-9-]*)?((?:[.#][\w-]+|\[[^\]]+\])*)$/);
  if (parsed === null) return false;
  const [, tag, rest] = parsed;
  if (tag !== undefined && tag !== "" && node.tagName !== tag.toUpperCase()) return false;
  for (const token of (rest ?? "").match(/[.#][\w-]+|\[[^\]]+\]/g) ?? []) {
    if (token.startsWith(".")) {
      if (!node.classes.has(token.slice(1))) return false;
    } else if (token.startsWith("[")) {
      if (!matchesAttribute(node, token)) return false;
    } else if (String(node.attributes.id ?? node.id) !== token.slice(1)) {
      return false;
    }
  }
  return true;
}

/** Matches a descendant-combinator chain, right to left. */
function matchesComplex(node: ShimElement, parts: string[]): boolean {
  const last = parts[parts.length - 1];
  if (last === undefined || !matchesSimple(node, last)) return false;
  if (parts.length === 1) return true;

  const rest = parts.slice(0, -1);
  let ancestor = node.parentNode;
  while (ancestor !== null) {
    if (matchesComplex(ancestor, rest)) return true;
    ancestor = ancestor.parentNode;
  }
  return false;
}

function matchesSelector(node: ShimElement, selector: string): boolean {
  return selector.split(",").some((group) => {
    const parts = group.trim().split(/\s+/).filter(Boolean);
    return parts.length > 0 && matchesComplex(node, parts);
  });
}

function applyOptions(element: ShimElement, options: unknown): void {
  if (options === undefined || options === null) return;
  if (typeof options === "string") {
    element.addClass(...options.split(/\s+/).filter(Boolean));
    return;
  }
  const spec = options as Record<string, unknown>;
  if (spec.cls !== undefined) {
    const list = Array.isArray(spec.cls) ? spec.cls : String(spec.cls).split(/\s+/);
    element.addClass(...list.filter(Boolean).map(String));
  }
  if (spec.text !== undefined) element.setText(String(spec.text));
  if (spec.title !== undefined) element.setAttr("title", spec.title);
  if (spec.attr !== undefined) Object.assign(element.attributes, spec.attr);
  if (spec.type !== undefined) element.setAttr("type", spec.type);
  if (spec.placeholder !== undefined) element.setAttr("placeholder", spec.placeholder);
  if (spec.href !== undefined) element.setAttr("href", spec.href);
  if (spec.value !== undefined) element.value = String(spec.value);
  if (spec.onclick !== undefined) element.addEventListener("click", spec.onclick as () => void);
}

class ShimStyleElement extends ShimElement {}

/** A class (not a plain object) so `instanceof` checks elsewhere keep working. */
class ShimNode {}

export const SHIM_NODE = Object.assign(ShimNode, {
  ELEMENT_NODE: 1,
  TEXT_NODE: 3,
  DOCUMENT_NODE: 9
});

class ShimNodeFilter {}

const head = new ShimElement("head");
const body = new ShimElement("body");
const documentElement = new ShimElement("html");

export const shimDocument = {
  head,
  body,
  documentElement,
  cookie: "",
  activeElement: null as ShimElement | null,
  createElement: (tag: string): ShimElement =>
    String(tag) === "style" ? new ShimStyleElement(tag) : new ShimElement(tag),
  createTextNode: (text: string): ShimElement => {
    const node = new ShimElement("#text");
    node.textContent = text;
    return node;
  },
  createDocumentFragment: (): ShimElement => new ShimElement("#fragment"),
  getElementById: (id: string): ShimElement | null => {
    const visit = (node: ShimElement): ShimElement | null => {
      if (node.id === id || node.attributes.id === id) return node;
      for (const child of node.children) {
        const found = visit(child);
        if (found !== null) return found;
      }
      return null;
    };
    return visit(head) ?? visit(body);
  },
  querySelector: (): ShimElement | null => null,
  querySelectorAll: (): ShimElement[] => [],
  addEventListener: (): void => {},
  removeEventListener: (): void => {}
};

const windowListeners = new Map<string, Array<(event: unknown) => void>>();

export function fireWindowEvent(type: string, event: Record<string, unknown> = {}): void {
  for (const handler of windowListeners.get(type) ?? []) {
    handler({ preventDefault() {}, stopPropagation() {}, ...event });
  }
}

function defineGlobal(name: string, value: unknown): void {
  // Node exposes some globals (e.g. `navigator`) as getter-only properties.
  try {
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  } catch {
    (globalThis as Record<string, unknown>)[name] = value;
  }
}

export function installDom(): void {
  const globalObject = globalThis as Record<string, unknown>;
  const define = defineGlobal;

  define("document", shimDocument);
  define("HTMLElement", ShimElement);
  define("HTMLStyleElement", ShimStyleElement);
  define("HTMLInputElement", ShimElement);
  define("HTMLButtonElement", ShimElement);
  define("Element", ShimElement);
  define("Node", SHIM_NODE);
  define("NodeFilter", ShimNodeFilter);
  define("window", globalThis);
  define("navigator", {
    userAgent: "weaver-test",
    platform: "MacIntel",
    vendor: "",
    maxTouchPoints: 0
  });
  define("innerHeight", 900);
  define("innerWidth", 1400);
  define("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  define("visualViewport", { height: 900, addEventListener() {}, removeEventListener() {} });
  define("getSelection", () => ({
    rangeCount: 0,
    anchorNode: null,
    focusNode: null,
    addRange() {},
    removeAllRanges() {},
    getRangeAt: () => null,
    extend() {}
  }));
  define("MutationObserver", class {
    observe(): void {}
    disconnect(): void {}
    takeRecords(): unknown[] {
      return [];
    }
  });
  define("ResizeObserver", class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  define("DOMRect", class {
    x: number;
    y: number;
    width: number;
    height: number;
    top: number;
    left: number;
    right: number;
    bottom: number;

    constructor(x = 0, y = 0, width = 0, height = 0) {
      this.x = x;
      this.y = y;
      this.width = width;
      this.height = height;
      this.top = y;
      this.left = x;
      this.right = x + width;
      this.bottom = y + height;
    }
  });
  define("requestAnimationFrame", (callback: (time: number) => void): number =>
    setTimeout(() => callback(Date.now()), 0) as unknown as number);
  define("cancelAnimationFrame", (handle: number): void => clearTimeout(handle));
  define("scrollTo", (): void => {});
  define("addEventListener", (type: string, handler: (event: unknown) => void): void => {
    const list = windowListeners.get(type) ?? [];
    list.push(handler);
    windowListeners.set(type, list);
  });
  define("removeEventListener", (type: string, handler: (event: unknown) => void): void => {
    windowListeners.set(
      type,
      (windowListeners.get(type) ?? []).filter((candidate) => candidate !== handler)
    );
  });
  void globalObject;
}

/** Clears DOM state between tests. */
export function resetDom(): void {
  head.children = [];
  head.textContent = "";
  body.children = [];
  body.textContent = "";
  body.classes.clear();
}
