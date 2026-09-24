# Darjeeling — Design System & Brand Architecture

Named for the region, Darjeeling's design system draws from the terroir of a Himalayan tea garden rather than a generic dark-mode palette with a green accent.

---

## 1. The ADR-20 Token Architecture

Darjeeling adheres to **ADR-20**, providing a layered design token architecture:

1. **Semantic Layer (Default Root)**:
   - Defined on `.darjeeling-root`.
   - Maps 1:1 to Obsidian's core theme variables (`--background-primary`, `--text-normal`, `--interactive-accent`, `--background-modifier-border`, etc.).
   - Ensures seamless harmony with standard community themes (Minimal, AnuPpuccin, Primary, Default Obsidian).
   - Exposes clean semantic aliases: `--dj-bg`, `--dj-surface`, `--dj-text`, `--dj-accent`, `--dj-border`, `--dj-font-size-ui`, `--dj-font-size-mono`.
   - Status indicators (`--dj-ok`, `--dj-warn`, `--dj-crit`, `--dj-spec`) map to Obsidian color variables with graceful fallback values.

2. **Light Theme Contrast Calibration**:
   - Scoped to `.theme-light .darjeeling-root` and `body.theme-light .darjeeling-root`.
   - Status colors (`--dj-ok`, `--dj-warn`, `--dj-crit`) are darkened dynamically via CSS `color-mix()` against black (60%, 55%, 70%) to ensure compliance with WCAG AA (≥4.5:1 for text, ≥3:1 for UI components).
   - Semi-transparent washes (`--dj-*-wash`) and meter tracks (`--dj-*-track`) use `color-mix(in srgb, ..., transparent)` to adapt automatically to any background luminance without muddying.

3. **Opt-in Tea Terroir Palette (`.dj-palette-tea`)**:
   - Elevation and oxidation ramps (`--dj-soil-*`, `--dj-leaf-*`, `--dj-ox-*`, `--dj-mist-*`, `--dj-flush-*`, `--dj-pekoe-*`) are encapsulated under the `.darjeeling-root.dj-palette-tea` modifier class.
   - Components requiring branded elevation depth opt in explicitly without polluting external Obsidian workspace leaves.

4. **Zero `!important` Policy**:
   - `tokens.css` and `base.css` strictly contain **zero `!important`** declarations.
   - Specificity is managed via structured hierarchical class selectors (e.g., `.workspace-leaf-content[data-type="darjeeling-view"] .darjeeling-root`).

---

## 2. The Two Color Spaces: Display sRGB vs. Terminal ANSI

Darjeeling renders both graphical web views and an xterm-powered terminal pane. Because text contrast requirements and terminal rendering differ fundamentally, colors are maintained in two distinct spaces:

### A. Display sRGB (CSS UI)
- Calculated in sRGB / OKLCH for screen surfaces.
- Surface separation relies on value, oxidation hue progression, and 1px hairline borders (`--dj-border`).
- Buttons use flat, un-beveled fills with background transitions on hover (`var(--background-modifier-hover)`), preserving flat editorial typography.

### B. ANSI 256 / Truecolor (Terminal & Banner)
- Calibrated in `src/ui/theme.ts` via the `banner()` and `xtermTheme()` factories.
- **Dark Mode**:
  - Background: `#0c120d` (soil-900).
  - Text & Accents: ANSI Mist (`#a4b09e`), Amber (`#d97706`), Tea Green (`#4ade80`).
- **Light Mode (`isLightTheme()`)**:
  - Background: Obsidian light background (`#f7f3e8` or `#ffffff`).
  - Banner Title: Switches from low-contrast `ANSI.mist` (which fails at 2.04:1) to deep forest green `#2A382B`, achieving >7.0:1 contrast.
  - Status Codes: Calibrated to darkened ANSI values: Error `#A3351F`, Ok `#3F6B45`, Warn `#8A6A14`, Accent `#A8541A`.

---

## 3. Vector Mark Architecture & Illustration Factories

To comply with Obsidian plugin directory security rules (`OBS-06`, `DM-30`), all icons and illustrations use structured DOM element factories rather than raw string injection (`innerHTML`).

### A. Element Factories (`src/ui/illustrations.ts`)
- `createChatEmptyState()`: Renders the tea-tasting bowl with steaming mist.
- `createPlanEmptyState()`: Renders the multi-tier terrace hillside with ridgeline elevation.
- `createPlanIllustration()`: Renders milestone stage badges.
- `createAppMark()`: Renders the 2-leaves-and-a-bud brand mark.
- Built via `DOMParser().parseFromString(..., "image/svg+xml")` to ensure safe, validated `SVGElement` node trees.

### B. Dynamic Gradient & Clip-Path Collision Prevention
- Multiple Obsidian leaves or sidebars can be open concurrently. Static SVG element IDs (`#grad`, `#clip`) cause rendering conflicts and disappearing gradients.
- Every SVG factory generates unique IDs per instance via `nextId(prefix)` (e.g., `dj-bowl-rim-1`, `dj-bowl-rim-2`).

### C. Deprecated Asset Purge
- All legacy base64 raster PNGs (`data:image/png;base64`) and hardcoded gradient IDs (`djLeafGrad`) have been purged from `src/`.
- Porcelain bone-china colors are governed by semantic tokens: `--dj-cup-porcelain-top`, `--dj-cup-porcelain-bot`, `--dj-cup-border`, `--dj-cup-tea-fill`.

---

## 4. Mobile Baseline & Responsive Design

### A. Single Touch Baseline (`(pointer: coarse)`)
- Mobile ergonomics are consolidated into a single `@media (pointer: coarse)` query in `src/css/base.css`.
- Enforces a minimum **44px × 44px hit target** across all interactive controls:
  - Header icon buttons (`.dj-btn-icon`)
  - Mode selector tabs (`.dj-tab`)
  - Form action buttons (`.dj-btn`)
  - Input fields and composer actions (`.dj-composer-actions button`)
  - Status and pairing chips (`.dj-chip-pill`)
- Redundant, conflicting `body.is-mobile` and `body.is-phone` media blocks have been eliminated.

### B. Container Queries
- Darjeeling panels frequently live in an Obsidian sidebar (typically 320px–420px wide) inside a high-resolution display (2560px+).
- Window-level `@media (max-width: ...)` queries fail because the window is wide while the pane is narrow.
- `.darjeeling-root` is declared as `container-type: inline-size; container-name: darjeeling;`.
- Responsive breakpoints are handled via `@container darjeeling (max-width: 480px)`:
  - Wordmarks hide, collapsing the header to icon-only.
  - KPI metric cards reflow from multi-column rows into two-column or stacked layouts.
  - Action button groups compress gracefully.

### C. Accessibility & Motion
- Focus visibility: `:focus-visible` ring token with high-contrast outlines and forced-colors support (`@media (forced-colors: active)`).
- Hover gating: Hover states are gated behind `@media (hover: hover) and (pointer: fine)` to avoid sticky hover states on mobile touch displays.
- Reduced motion: `@media (prefers-reduced-motion: reduce)` dampens all pulses, spins, and transitions to instantaneous state changes.

---

## 5. Contrast Audit & Dataviz Validation

All status colors and text ramps are verified against the dataviz six-checks per surface:

| Surface | OK | Warn | Critical | Special | Result |
|---|---|---|---|---|---|
| **Dark (`#0c120d`)** | `#46a86f` | `#d4a72c` | `#c2452f` | `#9b5c6b` | CVD ΔE 8.7 protan / 22.0 tritan; normal 17.5; all ≥3:1 against background |
| **Light (`#f7f3e8`)** | `#0f7a52` | `#a07a12` | `#a82f1c` | `#7d4654` | Passes WCAG AA; all ≥4.5:1 against light surfaces |

---

## 6. CSS Quality & CI Verification

The CSS suite is verified in CI using `npm run lint:css` (`scripts/ci/css-lint.mjs`), which enforces:
1. **0 `!important`** in `tokens.css` and `base.css` (`OBS-22`).
2. Allow-list compliance for remaining `!important` statements in sprint-owned files (`terminal.css` for xterm, `overrides.css` for Obsidian modal layout).
3. **0 undefined `--dj-*` custom properties** across all stylesheet files (`VTH-38`).
4. **0 missing `@keyframes`** for any referenced CSS animation (`DM-19`).
5. **0 raw un-tokenized hex literals** outside `tokens.css` (`DM-03`).
6. **0 legacy assets** (`djLeafGrad` or `data:image/png;base64`) across `src/` (`OBS-05`, `OBS-06`).
7. Balanced syntax and valid brace trees in the compiled `styles.css`.

### Running Verification Locally
```bash
# Build stylesheet
npm run build:css

# Run CSS quality & theming linter
npm run lint:css

# Run test suite
npm test
```
