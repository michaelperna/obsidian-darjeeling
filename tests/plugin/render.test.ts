import test from "node:test";
import assert from "node:assert/strict";
import {
  SAFE_HIGHLIGHT_LANGUAGES,
  sanitizeUntrustedMarkdown,
  setupRemoteMediaHandlers,
  paintTurn,
  scheduleThrottledRender,
  flushPendingRender,
  createBubble,
  LiveTurn,
} from "../../src/ui/chat/render";
import { Component } from "./stubs/obsidian";

function makeFakeDomNode(tag = "div"): any {
  const node: any = {
    tagName: tag.toUpperCase(),
    children: [] as any[],
    classList: new Set<string>(),
    attributes: new Map<string, string>(),
    style: {},
    textContent: "",
    innerHTML: "",
    dataset: {} as Record<string, string>,
    listeners: new Map<string, Array<(...args: any[]) => void>>(),
    setText(t: string) {
      node.textContent = t;
      return node;
    },
    getText() {
      return node.textContent;
    },
    empty() {
      node.children.length = 0;
      node.textContent = "";
      node.innerHTML = "";
    },
    createDiv(opts?: any) {
      return node.createEl("div", opts);
    },
    createSpan(opts?: any) {
      return node.createEl("span", opts);
    },
    createEl(t: string, opts?: any) {
      const child = makeFakeDomNode(t);
      if (opts?.cls) {
        for (const c of opts.cls.split(" ")) {
          if (c) child.classList.add(c);
        }
      }
      if (opts?.text) child.textContent = opts.text;
      if (opts?.attr) {
        for (const [k, v] of Object.entries(opts.attr)) {
          child.attributes.set(k, String(v));
        }
      }
      node.children.push(child);
      return child;
    },
    appendChild(child: any) {
      node.children.push(child);
      return child;
    },
    replaceWith(newNode: any) {
      node.replacedWith = newNode;
    },
    remove() {
      node.removed = true;
    },
    addClass(cls: string) {
      node.classList.add(cls);
    },
    removeClass(cls: string) {
      node.classList.delete(cls);
    },
    hasClass(cls: string) {
      return node.classList.has(cls);
    },
    setAttribute(k: string, v: string) {
      node.attributes.set(k, v);
    },
    getAttribute(k: string) {
      return node.attributes.get(k) ?? null;
    },
    addEventListener(type: string, fn: (...args: any[]) => void) {
      if (!node.listeners.has(type)) node.listeners.set(type, []);
      node.listeners.get(type).push(fn);
    },
    dispatchEvent(event: { type: string }) {
      const list = node.listeners.get(event.type) ?? [];
      for (const fn of list) fn(event);
    },
    querySelector(selector: string): any {
      return node.querySelectorAll(selector)[0] ?? null;
    },
    querySelectorAll(selector: string): any[] {
      const matched: any[] = [];
      const traverse = (n: any) => {
        if (selector.startsWith(".") && n.hasClass(selector.slice(1))) {
          matched.push(n);
        } else if (selector.toUpperCase() === n.tagName) {
          matched.push(n);
        }
        for (const c of n.children) traverse(c);
      };
      for (const c of node.children) traverse(c);
      return matched;
    },
  };
  return node;
}

test("SAFE_HIGHLIGHT_LANGUAGES contains common code languages but excludes Obsidian plugin codeblock targets", () => {
  assert.ok(SAFE_HIGHLIGHT_LANGUAGES.has("typescript"));
  assert.ok(SAFE_HIGHLIGHT_LANGUAGES.has("python"));
  assert.ok(SAFE_HIGHLIGHT_LANGUAGES.has("json"));
  assert.ok(SAFE_HIGHLIGHT_LANGUAGES.has("bash"));
  assert.ok(SAFE_HIGHLIGHT_LANGUAGES.has("markdown"));

  assert.equal(SAFE_HIGHLIGHT_LANGUAGES.has("dataview"), false);
  assert.equal(SAFE_HIGHLIGHT_LANGUAGES.has("dataviewjs"), false);
  assert.equal(SAFE_HIGHLIGHT_LANGUAGES.has("tasks"), false);
  assert.equal(SAFE_HIGHLIGHT_LANGUAGES.has("execute"), false);
});

test("sanitizeUntrustedMarkdown converts dangerous fences to pre blocks (ADR-17)", () => {
  const dangerous = "```dataviewjs\ndv.header(2, 'Danger');\n```";
  const sanitized = sanitizeUntrustedMarkdown(dangerous);
  assert.ok(
    sanitized.includes('<pre class="dj-code-block dj-restricted-fence"><code class="language-dataviewjs">')
  );
  assert.ok(!sanitized.includes("```dataviewjs"));
  assert.ok(sanitized.includes("dv.header(2, &#39;Danger&#39;);"));
});

test("sanitizeUntrustedMarkdown preserves safe whitelisted code fences", () => {
  const safe = "```python\nprint('hello')\n```";
  const result = sanitizeUntrustedMarkdown(safe);
  assert.equal(result, safe);
});

test("sanitizeUntrustedMarkdown transforms remote images to click-to-load placeholders", () => {
  const remoteMd = "Check this: ![sample graph](https://example.com/chart.png) done.";
  const sanitized = sanitizeUntrustedMarkdown(remoteMd);
  assert.ok(sanitized.includes('data-src="https://example.com/chart.png"'));
  assert.ok(sanitized.includes('data-alt="sample graph"'));
  assert.ok(sanitized.includes("dj-remote-media-btn"));
  assert.ok(!sanitized.includes("![sample graph]"));
});

test("setupRemoteMediaHandlers activates image on click", () => {
  const host = makeFakeDomNode("div");
  const container = host.createDiv({ cls: "dj-remote-media" });
  container.dataset = {
    src: "https://example.com/cat.jpg",
    alt: "A cool cat",
  };
  const btn = container.createEl("button", {
    cls: "dj-remote-media-btn",
  });

  setupRemoteMediaHandlers(host);

  // Simulate click on button
  btn.dispatchEvent({ type: "click" });

  assert.equal(container.children.length, 1);
  const img = container.children[0];
  assert.equal(img.tagName, "IMG");
  assert.equal(img.getAttribute("src"), "https://example.com/cat.jpg");
  assert.equal(img.getAttribute("alt"), "A cool cat");
});

test("paintTurn isolates child Component per paint", async () => {
  let childCount = 0;
  let unloadedCount = 0;

  class FakeChat extends Component {
    app = {} as any;
    plugin = { app: {} } as any;
    getPlugin() {
      return this.plugin;
    }
    addChild<T extends Component>(c: T): T {
      childCount++;
      const origUnload = c.unload.bind(c);
      c.unload = () => {
        unloadedCount++;
        origUnload();
      };
      return super.addChild(c);
    }
  }

  const chat = new FakeChat();
  const host = makeFakeDomNode("div");
  const turn: LiveTurn = {
    role: "assistant",
    bubbleEl: host,
    bodyEl: host.createDiv({ cls: "dj-msg-body" }),
    text: "Initial text",
    tools: new Map(),
  };

  // First paint
  await paintTurn(chat as any, turn);
  assert.equal(childCount, 1);
  assert.equal(unloadedCount, 0);
  assert.ok(turn.renderComponent);

  // Second paint unloads previous child and creates a new one
  turn.text = "Updated text";
  await paintTurn(chat as any, turn);
  assert.equal(childCount, 2);
  assert.equal(unloadedCount, 1);
  assert.equal(turn.renderCallCount, 2);
});

test("scheduleThrottledRender batches multiple text arrivals into minimal paints", async () => {
  let paints = 0;
  class FakeChat extends Component {
    app = {} as any;
    plugin = { app: {} } as any;
    getPlugin() {
      return this.plugin;
    }
  }
  const chat = new FakeChat();
  const host = makeFakeDomNode("div");
  const turn: LiveTurn = {
    role: "assistant",
    bubbleEl: host,
    bodyEl: host.createDiv({ cls: "dj-msg-body" }),
    text: "",
    tools: new Map(),
  };

  // Simulate 100 fast streaming chunks within single animation frame cycle
  for (let i = 0; i < 100; i++) {
    turn.text += ` delta_${i}`;
    scheduleThrottledRender(chat as any, turn, () => {
      paints++;
    });
  }

  // Wait for the throttled render to fire
  await new Promise((r) => setTimeout(r, 80));

  // 100 deltas should have resulted in only 1 paint
  assert.equal(paints, 1);
  assert.equal(turn.renderCallCount, 1);
});

test("flushPendingRender renders immediately and cancels pending throttled timer", async () => {
  let completeCalled = false;
  class FakeChat extends Component {
    app = {} as any;
    plugin = { app: {} } as any;
    getPlugin() {
      return this.plugin;
    }
  }
  const chat = new FakeChat();
  const host = makeFakeDomNode("div");
  const turn: LiveTurn = {
    role: "assistant",
    bubbleEl: host,
    bodyEl: host.createDiv({ cls: "dj-msg-body" }),
    text: "Pending text",
    tools: new Map(),
  };

  scheduleThrottledRender(chat as any, turn, () => {
    completeCalled = true;
  });

  assert.notEqual(turn.pendingRenderHandle, null);

  await flushPendingRender(chat as any, turn);

  assert.equal(turn.pendingRenderHandle, null);
  assert.equal(turn.lastRenderedText, "Pending text");
  assert.equal(turn.renderCallCount, 1);
});
