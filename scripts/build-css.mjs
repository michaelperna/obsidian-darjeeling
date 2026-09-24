#!/usr/bin/env node
/**
 * Assemble styles.css (ADR-20).
 *
 * Obsidian plugins ship exactly one stylesheet, so the sources are
 * concatenated here rather than @imported. Order is the cascade: when two
 * rules of equal specificity disagree, the later one wins.
 *
 * The component sheets in src/css/ were split out of one historical file
 * without moving a rule, so their order below is that file's order, and a
 * sheet named for one component can carry rules its position requires. They
 * are joined verbatim, exactly as the single file was; the other parts are
 * trimmed and separated by a blank line each.
 *
 * Run after editing anything under src/css/ or regenerating textures.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

const COMPONENT_SHEETS = [
  "tokens.css", //        palette custom properties, dark and light
  "header.css", //        view shell, header, subbar, shared controls, mode tabs, status, terminal context strip, panes
  "chat.css", //          messages, tool calls, turn footer
  "composer.css", //      composer
  "plan.css", //          plans, phases, verification findings
  "terminal.css", //      terminal pane
  "settings.css", //      settings tab, conversation picker rows
  "vault.css", //         vault note status, changed files, pull UI
  "base.css", //          narrow-container and coarse-pointer overrides for every component
  "modals.css", //        new-session host selector modal
  "pairing.css", //       device pairing and confirmation modal
  "onboarding.css", //    stepped in-view onboarding (S0-S4)
  "illustrations.css", // tea-cup animations, porcelain cup, theme-aware logos
  "overrides.css", //     later layers: thinking indicator, empty states, composer island,
  //                      queue, quick-settings modal, thinking drawer, offline and
  //                      session-starting cards, ribbon icon colours
];

const XTERM_BANNER = `/* ==========================================================================
   Vendored: xterm.js base stylesheet (@xterm/xterm v5.5.0, MIT).
   --------------------------------------------------------------------------
   xterm.js does not function without this -- rows, cursor and selection are
   absolutely positioned by it. Obsidian plugins ship a single styles.css and
   cannot @import from node_modules at runtime, so it is vendored here.
   Do not hand-edit; re-vendor from node_modules/@xterm/xterm/css/xterm.css.
   ========================================================================== */

`;

const parts = [
  read("textures/textures.css"),
  read("textures/mark.css"),
  COMPONENT_SHEETS.map((sheet) => read(`src/css/${sheet}`)).join(""),
  read("src/css/host.css"),
  XTERM_BANNER + read("node_modules/@xterm/xterm/css/xterm.css"),
];

const out = parts.map((part) => part.replace(/\s+$/, "") + "\n").join("\n\n");
writeFileSync(path.join(root, "styles.css"), out);

const opens = out.split("{").length - 1;
const closes = out.split("}").length - 1;
const lineCount = out.split("\n").length - (out.endsWith("\n") ? 1 : 0);
console.log(
  `styles.css  ${lineCount} lines  braces ${opens}/${closes} ${opens === closes ? "balanced" : "MISMATCH"}`
);
if (opens !== closes) process.exitCode = 1;
