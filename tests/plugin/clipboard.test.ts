import test from "node:test";
import assert from "node:assert/strict";
import { Terminal } from "./stubs/xterm";
import {
  extractUrls,
  framePaste,
  attachClipboardKeys,
  writeClipboard,
  readClipboard,
} from "../../src/ui/terminal/clipboard";

test("framePaste: normalises line endings to \\r", () => {
  const term = new Terminal();
  term.modes = { bracketedPasteMode: false };

  const input = "echo hello\r\necho world\nls -la";
  const pasted = framePaste(term as any, input);

  assert.equal(pasted, "echo hello\recho world\rls -la");
});

test("framePaste: strips bracketed paste markers from pasted text (VTH-32)", () => {
  const term = new Terminal();
  term.modes = { bracketedPasteMode: false };

  const malicious = "safe command\x1b[201~evil command\x1b[200~";
  const pasted = framePaste(term as any, malicious);

  assert.ok(!pasted.includes("\x1b[201~"));
  assert.ok(!pasted.includes("\x1b[200~"));
  assert.equal(pasted, "safe commandevil command");
});

test("framePaste: wraps in bracketed markers when terminal mode is active", () => {
  const term = new Terminal();
  term.modes = { bracketedPasteMode: true };

  const input = "function test() {\n  return 42;\n}";
  const pasted = framePaste(term as any, input);

  assert.equal(pasted, "\x1b[200~function test() {\r  return 42;\r}\x1b[201~");
});

test("extractUrls: extracts clean URLs and strips trailing punctuation (VTH-16)", () => {
  const term = new Terminal();
  term.cols = 80;

  const lines = [
    "Check out https://github.com/darjeeling/core.",
    "Visit (https://example.com/docs), or https://api.example.com/v1;",
  ];

  term.buffer = {
    active: {
      length: lines.length,
      cursorY: 0,
      viewportY: 0,
      getLine: (i: number) => ({
        isWrapped: false,
        translateToString: () => lines[i],
      }),
    },
  } as any;

  const urls = extractUrls(term as any);
  assert.deepEqual(urls, [
    "https://github.com/darjeeling/core",
    "https://example.com/docs",
    "https://api.example.com/v1",
  ]);
});

test("extractUrls: rejoins hard-wrapped URL lines and stops at shell prompts (VTH-16)", () => {
  const term = new Terminal();
  term.cols = 40;

  // Line 1 is hard-wrapped exactly at terminal margin (40 chars)
  const line1 = "Authorize at: https://accounts.google.co"; // 40 chars
  const line2 = "m/o/oauth2/auth?client_id=123";
  const line3 = "user@thinkpad:~$ "; // prompt line

  const lines = [line1, line2, line3];

  term.buffer = {
    active: {
      length: lines.length,
      cursorY: 0,
      viewportY: 0,
      getLine: (i: number) => ({
        isWrapped: false,
        translateToString: () => lines[i],
      }),
    },
  } as any;

  const urls = extractUrls(term as any);
  assert.equal(urls.length, 1);
  assert.equal(
    urls[0],
    "https://accounts.google.com/o/oauth2/auth?client_id=123"
  );
  assert.ok(!urls[0].includes("user@thinkpad"));
});

test("attachClipboardKeys: does not intercept Cmd/Ctrl+V, allowing native paste (VTH-04)", () => {
  const term = new Terminal();
  let customHandler: ((e: KeyboardEvent) => boolean) | null = null;
  term.attachCustomKeyEventHandler = (fn: any) => {
    customHandler = fn;
  };

  attachClipboardKeys(term as any, () => {});
  assert.ok(customHandler, "custom key event handler attached");

  // Cmd+V
  const cmdV = {
    type: "keydown",
    metaKey: true,
    ctrlKey: false,
    key: "v",
  } as unknown as KeyboardEvent;

  // Returning true tells xterm to handle the event natively
  const res = customHandler!(cmdV);
  assert.equal(res, true, "Cmd+V should return true to let xterm handle native paste");

  // Ctrl+V
  const ctrlV = {
    type: "keydown",
    metaKey: false,
    ctrlKey: true,
    key: "v",
  } as unknown as KeyboardEvent;
  assert.equal(customHandler!(ctrlV), true, "Ctrl+V should return true for native paste");
});

test("attachClipboardKeys: copies selection on Cmd/Ctrl+C and passes SIGINT when no selection", () => {
  const term = new Terminal();
  let customHandler: ((e: KeyboardEvent) => boolean) | null = null;
  term.attachCustomKeyEventHandler = (fn: any) => {
    customHandler = fn;
  };

  attachClipboardKeys(term as any, () => {});

  // With selection: intercepts and returns false
  term.setSelection("selected text");
  const cmdCWithSel = {
    type: "keydown",
    metaKey: true,
    ctrlKey: false,
    key: "c",
  } as unknown as KeyboardEvent;

  assert.equal(customHandler!(cmdCWithSel), false, "Cmd+C with selection should copy and return false");
  assert.equal(term.getSelection(), "", "selection should be cleared after copy");

  // Without selection: returns true (so ^C reaches the terminal as SIGINT)
  const cmdCNoSel = {
    type: "keydown",
    metaKey: false,
    ctrlKey: true,
    key: "c",
  } as unknown as KeyboardEvent;
  assert.equal(customHandler!(cmdCNoSel), true, "Ctrl+C without selection should return true for SIGINT");
});
