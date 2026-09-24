/**
 * Darjeeling Runtime Environment Polyfills & Platform Shims
 *
 * Ensures Obsidian Mobile (WebKit / WKWebView on iOS and Chrome WebView on Android)
 * has standard properties expected by bundled dependencies (such as @xterm/xterm,
 * @xterm/addon-fit, and @xterm/addon-web-links) during initialization.
 */

import { Platform } from "obsidian";

/**
 * Executes `fn` with `navigator.platform` and window `self` safely defined
 * for WebKit/WKWebView on iOS/Android, then restores the original descriptor.
 */
export function withPlatformShim<T>(fn: () => T): T {
  const win = typeof window !== "undefined" ? (window as unknown as Record<string, unknown>) : undefined;
  const hadSelf = win !== undefined && "self" in win;
  const origSelf = win !== undefined ? win["self"] : undefined;
  let shimmedSelf = false;

  if (win !== undefined && typeof win["self"] === "undefined") {
    try {
      win["self"] = win;
      shimmedSelf = true;
    } catch (err: unknown) {
      void err;
    }
  }

  let origDesc: PropertyDescriptor | undefined;
  let hadPlatform = false;
  let shimmedPlatform = false;

  const nav = typeof navigator !== "undefined" ? (navigator as unknown as Record<string, unknown>) : undefined;

  if (nav !== undefined) {
    const desc = Object.getOwnPropertyDescriptor(nav, "platform");
    origDesc = desc;
    const currentPlatform = typeof nav["platform"] === "string" ? nav["platform"] : "";

    if (!currentPlatform) {
      try {
        const isAndroid = Platform.isAndroidApp;
        Object.defineProperty(navigator, "platform", {
          value: isAndroid ? "Linux armv8l" : "iPhone",
          configurable: true,
          enumerable: true,
          writable: true,
        });
        shimmedPlatform = true;
      } catch (err: unknown) {
        void err;
      }
    }
  }

  try {
    return fn();
  } finally {
    if (shimmedPlatform && nav !== undefined) {
      try {
        if (hadPlatform && origDesc) {
          Object.defineProperty(navigator, "platform", origDesc);
        } else {
          delete nav["platform"];
        }
      } catch (err: unknown) {
        void err;
      }
    }
    if (shimmedSelf && win !== undefined) {
      try {
        if (hadSelf) {
          win["self"] = origSelf;
        } else {
          delete win["self"];
        }
      } catch (err: unknown) {
        void err;
      }
    }
  }
}
