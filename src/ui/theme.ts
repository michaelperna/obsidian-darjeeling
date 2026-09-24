/**
 * Project Darjeeling — the Tea Garden design system.
 *
 * Read as a vertical section through a hillside at first flush:
 *
 *   MIST      cloud sitting on the ridge; the silver down on a young bud
 *   FLUSH     the two-leaves-and-a-bud, bright and translucent
 *   LEAF      mature bush, deep and matte
 *   OXIDATION the leaf turning — green losing to brown. A process, not a colour
 *   LIQUOR    what ends up in the cup: cream, straw, amber, brown, near-black
 *   SOIL      wet earth under the terraces
 *
 * Two ideas drive the whole thing:
 *
 * 1. **Depth is oxidation.** A surface that recedes does not merely darken, it
 *    browns — the same way a leaf does as it cures. So the elevation ramp walks
 *    from green toward brown-black rather than down a single neutral.
 *
 * Flat surfaces separate by value and hairline borders; the oxidation ramp
 * supplies depth. Texture is reserved for illustrative empty states.
 */

export const TEA = {
  // ---- Soil: wet earth beneath the terraces -----------------------------
  soil900: "#0B0E0B",
  soil850: "#0F1310",
  soil800: "#141915",

  // ---- Leaf: the mature bush --------------------------------------------
  leaf900: "#151E17",
  leaf800: "#1A261C",
  leaf700: "#213024",
  leaf600: "#2B3F2E",
  leaf500: "#3A5340",

  // ---- Flush: two leaves and a bud --------------------------------------
  flush500: "#4E7A52",
  flush400: "#6B9C6B",
  flush300: "#93BE8A",
  flush200: "#BBD9AE",

  // ---- Oxidation: the leaf turning. The elevation ramp lives here. ------
  ox900: "#12140F",
  ox800: "#1A1A13",
  ox700: "#241F16",
  ox600: "#31281A",
  ox500: "#40321F",

  // ---- Liquor: what ends up in the cup ----------------------------------
  cream: "#F4E9D2",
  straw: "#E6CE92",
  honey: "#D9A85C",
  pekoe: "#C4661F", // orange pekoe — the grade the accent is named for
  pekoeBright: "#E0822E",
  pekoeGlow: "#F2A85C",
  amber: "#A65E28",
  brew: "#6B3E1D",
  steep: "#432512",
  black: "#2A1A10",

  // ---- Mist & silver: cloud on the ridge, down on the bud ---------------
  silver: "#D8DCCF",
  silver200: "#BCC4B6",
  mist400: "#8A9887",
  mist300: "#A4B09E",
  mist200: "#C6CEBE",
  mist100: "#E4E9DC",
  mist050: "#F5F8F0",

  // ---- Muscatel: the region's tasting note -------------------------------
  muscatel600: "#7D4654",
  muscatel500: "#9B5C6B",
  muscatel400: "#C07E8C",

  // ---- Steeping water going green ---------------------------------------
  water600: "#37655A",
  water500: "#528577",
  water400: "#7FB0A0",
  water300: "#A3CDBE",

  // ---- Status. Validated per surface; see docs/telemetry.md. -------------
  stOk: "#46A86F",
  stWarn: "#D4A72C",
  stCrit: "#C2452F",

  // ---- Paper, for Obsidian's light themes -------------------------------
  paper100: "#F7F3E8",
  paper200: "#EFE8D8",
  paper300: "#E2D9C4",
  paper400: "#D0C4AA",
  paperInk: "#1B2118",
} as const;

/**
 * xterm theme. ANSI has no tea equivalent for blue, so blue maps onto the
 * steeping-water greens and the terminal stays inside the garden instead of
 * dropping a stock sky-blue into the middle of it.
 */
export const TEA_TERMINAL_THEME = {
  background: TEA.soil900,
  foreground: TEA.mist100,
  cursor: TEA.pekoeBright,
  cursorAccent: TEA.soil900,
  selectionBackground: "rgba(224, 130, 46, 0.26)",
  selectionForeground: TEA.mist050,

  black: TEA.leaf800,
  red: TEA.stCrit,
  green: TEA.flush400,
  yellow: TEA.straw,
  blue: TEA.water500,
  magenta: TEA.muscatel500,
  cyan: TEA.water400,
  white: TEA.mist100,

  brightBlack: TEA.leaf500,
  brightRed: "#E06A52",
  brightGreen: TEA.flush300,
  brightYellow: TEA.cream,
  brightBlue: TEA.water400,
  brightMagenta: TEA.muscatel400,
  brightCyan: TEA.water300,
  brightWhite: TEA.mist050,
};

export const TEA_TERMINAL_THEME_LIGHT = {
  ...TEA_TERMINAL_THEME,
  background: TEA.paper100,
  foreground: TEA.paperInk,
  cursor: TEA.amber,
  cursorAccent: TEA.paper100,
  selectionBackground: "rgba(166, 94, 40, 0.20)",
  selectionForeground: TEA.paperInk,
  black: TEA.paper400,
  brightBlack: "#A99C82",
  white: "#2A382B",
  brightWhite: TEA.paperInk,
  green: "#3F6B45",
  brightGreen: TEA.flush500,
  yellow: TEA.brew,
  brightYellow: TEA.amber,
  blue: TEA.water600,
  brightBlue: TEA.water500,
};

/** 24-bit ANSI helpers, for Darjeeling's own lines in the terminal stream. */
function fg(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}

export const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  pekoe: fg(TEA.pekoeBright),
  flush: fg(TEA.flush300),
  steep: fg(TEA.water400),
  gold: fg(TEA.straw),
  chili: fg("#E06A52"),
  mist: fg(TEA.mist300),
  silver: fg(TEA.silver),
  muscatel: fg(TEA.muscatel400),
};

/** Returns true if running in Obsidian with the light theme active. */
export function isLightTheme(): boolean {
  if (typeof document === "undefined" || !document.body) return false;
  const body = document.body;
  const obsidianBody = body as unknown as { hasClass?(cls: string): boolean };
  if (typeof obsidianBody.hasClass === "function") {
    return Boolean(obsidianBody.hasClass("theme-light"));
  }
  if (body.classList && typeof body.classList.contains === "function") {
    return body.classList.contains("theme-light");
  }
  return false;
}

/** Brand mark for terminal banners. Calibrated for light/dark terminal backgrounds (VTH-33). */
export function banner(text: string, colour?: string, isLight?: boolean): string {
  const light = isLight !== undefined ? isLight : isLightTheme();
  const textCol = light ? fg("#2A382B") : ANSI.mist;
  let statusCol = colour || (light ? fg("#A8541A") : ANSI.pekoe);
  if (light) {
    if (colour === ANSI.chili) statusCol = fg("#A3351F");
    else if (colour === ANSI.flush) statusCol = fg("#3F6B45");
    else if (colour === ANSI.gold) statusCol = fg("#8A6A14");
    else if (colour === ANSI.pekoe || !colour) statusCol = fg("#A8541A");
  }
  return `${statusCol}Darjeeling${ANSI.reset} ${textCol}${text}${ANSI.reset}`;
}
