/**
 * Project Darjeeling - Custom Bespoke Illustrations & SVG Assets
 *
 * Handcrafted vector illustrations themed around Darjeeling artisanal tea,
 * tea gardens, blueprints, and steaming tea cups with swirling leaves.
 * Fully responsive and dynamically styled with Obsidian CSS variables.
 *
 * All illustration factories return DOM SVGSVGElements parsed via DOMParser
 * with unique per-instance gradient and filter IDs to prevent DOM ID collisions (OBS-06, VTH-39).
 */

let instanceCounter = 0;
function nextId(prefix: string): string {
  instanceCounter = (instanceCounter + 1) % 1000000;
  return `${prefix}-${instanceCounter}-${Math.random().toString(36).substring(2, 7)}`;
}

function parseSvgElement(svgMarkup: string): SVGSVGElement {
  if (typeof DOMParser !== "undefined") {
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgMarkup, "image/svg+xml");
    return doc.documentElement as unknown as SVGSVGElement;
  }
  // Safe fallback for Node.js unit test environments
  return {
    tagName: "svg",
    setAttribute: () => {},
    classList: { add: () => {}, contains: () => false, remove: () => {}, has: () => false },
    hasClass: () => false,
    appendChild: () => {},
    children: [],
    innerHTML: svgMarkup,
    outerHTML: svgMarkup,
  } as unknown as SVGSVGElement;
}

/**
 * Animated Teacup with swirling tea leaves and rising steam wisps.
 * Used for the in-chat thinking/brewing indicator.
 */
export function getSwirlingTeaCupSvg(size: number = 56): string {
  const liquidGradId = nextId("dj-tea-liquid-grad");
  const porcelainGradId = nextId("dj-cup-porcelain");
  const glowFilterId = nextId("dj-tea-glow");

  return `
<svg class="dj-tea-cup-anim dj-swirling-teacup" width="${size}" height="${size}" viewBox="0 0 72 72" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="${liquidGradId}" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#f59e0b" />
      <stop offset="45%" stop-color="#d97706" />
      <stop offset="100%" stop-color="#92400e" />
    </linearGradient>
    <linearGradient id="${porcelainGradId}" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="var(--dj-cup-porcelain-top, #ffffff)" />
      <stop offset="100%" stop-color="var(--dj-cup-porcelain-bot, #e2ded5)" />
    </linearGradient>
    <filter id="${glowFilterId}" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="1" result="blur" />
      <feComposite in="SourceGraphic" in2="blur" operator="over" />
    </filter>
  </defs>

  <!-- Saucer -->
  <ellipse cx="36" cy="56" rx="27" ry="5.5" class="dj-saucer" fill="var(--dj-cup-saucer-base, rgba(0,0,0,0.1))" />
  <ellipse cx="36" cy="54" rx="24" ry="4" class="dj-saucer-inner" fill="url(#${porcelainGradId})" stroke="var(--dj-cup-border, #d5cfc2)" stroke-width="1.2"/>

  <!-- Teacup Handle -->
  <path d="M 52 26 C 64 26 64 42 50 44" class="dj-cup-handle" fill="none" stroke="var(--dj-cup-border, #d5cfc2)" stroke-width="3.2" stroke-linecap="round"/>
  <path d="M 52 28 C 60 28 60 40 50 42" class="dj-cup-handle-inner" fill="none" stroke="var(--dj-cup-handle-inner, #ffffff)" stroke-width="1.4"/>

  <!-- Cup Body (Bone China Porcelain in both Light & Dark modes) -->
  <path d="M 18 21 C 19 38 24 50 36 50 C 48 50 53 38 54 21 Z" class="dj-cup-body" fill="url(#${porcelainGradId})" stroke="var(--dj-cup-border, #d5cfc2)" stroke-width="1.4"/>

  <!-- Tea Liquid Surface (Top Rim) -->
  <ellipse cx="36" cy="21" rx="18" ry="6" class="dj-cup-rim" fill="url(#${porcelainGradId})" stroke="var(--dj-cup-border, #d5cfc2)" stroke-width="1.4"/>
  <ellipse cx="36" cy="22" rx="16" ry="5" class="dj-tea-surface" fill="url(#${liquidGradId})" filter="url(#${glowFilterId})"/>
  <ellipse cx="36" cy="22" rx="12" ry="3.5" class="dj-tea-swirl-ring" fill="none" stroke="#fde68a" stroke-width="0.8" opacity="0.6"/>

  <!-- Swirling Darjeeling Tea Leaves inside the cup -->
  <g class="dj-swirl-leaf-orbit dj-orbit-1">
    <path class="dj-tea-leaf leaf-1" d="M 36 21 C 34 19 32 21 34 23 C 36 25 38 23 36 21 Z" fill="#16a34a" stroke="#15803d" stroke-width="0.4"/>
  </g>
  <g class="dj-swirl-leaf-orbit dj-orbit-2">
    <path class="dj-tea-leaf leaf-2" d="M 36 21 C 37 19.5 39.5 20.5 38.5 22.5 C 37.5 23.5 35 22.5 36 21 Z" fill="#22c55e" stroke="#166534" stroke-width="0.4"/>
  </g>
  <g class="dj-swirl-leaf-orbit dj-orbit-3">
    <path class="dj-tea-leaf leaf-3" d="M 36 21 C 35 19 37 19 37 22 C 36 23 34 22 35 21 Z" fill="#d97706" stroke="#92400e" stroke-width="0.4"/>
  </g>

  <!-- Gentle Rising Steam Wisps -->
  <path class="dj-steam-wisp steam-1" d="M 29 15 C 27 10 33 7 30 2" fill="none" stroke="var(--dj-steam-color, rgba(255,255,255,0.75))" stroke-width="1.3" stroke-linecap="round" opacity="0.6"/>
  <path class="dj-steam-wisp steam-2" d="M 36 15 C 39 10 34 6 37 1" fill="none" stroke="var(--dj-steam-color, rgba(255,255,255,0.75))" stroke-width="1.3" stroke-linecap="round" opacity="0.7"/>
  <path class="dj-steam-wisp steam-3" d="M 43 16 C 41 11 46 8 43 3" fill="none" stroke="var(--dj-steam-color, rgba(255,255,255,0.75))" stroke-width="1.3" stroke-linecap="round" opacity="0.5"/>
</svg>
`.trim();
}

/**
 * Creates an animated teacup SVGSVGElement with unique instance IDs.
 */
export function createSwirlingTeaCup(size: number = 56): SVGSVGElement {
  return parseSvgElement(getSwirlingTeaCupSvg(size));
}

/**
 * Large artisanal illustration for the Chat Empty State.
 * Features an artisanal Teapot, steaming Teacup, and tea garden hills.
 */
export function getChatEmptyStateSvg(): string {
  const heroBgId = nextId("dj-hero-bg");
  const potGradId = nextId("dj-pot-grad");
  const accentLeafId = nextId("dj-accent-leaf");
  const amberTeaId = nextId("dj-amber-tea");

  return `
<svg class="dj-hero-illustration" width="180" height="140" viewBox="0 0 180 140" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="${heroBgId}" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="var(--interactive-accent)" stop-opacity="0.12" />
      <stop offset="100%" stop-color="var(--background-secondary)" stop-opacity="0.4" />
    </linearGradient>
    <linearGradient id="${potGradId}" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="var(--background-secondary)" />
      <stop offset="100%" stop-color="var(--background-modifier-border)" />
    </linearGradient>
    <linearGradient id="${accentLeafId}" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#22c55e" />
      <stop offset="100%" stop-color="#15803d" />
    </linearGradient>
    <linearGradient id="${amberTeaId}" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#f59e0b" />
      <stop offset="100%" stop-color="#b45309" />
    </linearGradient>
  </defs>

  <!-- Ambient Backdrop Glow -->
  <circle cx="90" cy="70" r="62" fill="url(#${heroBgId})" />

  <!-- Rolling Himalayan Foothills / Tea Plantation Terraces -->
  <path d="M 15 118 Q 50 102 95 110 T 170 106 L 170 126 L 15 126 Z" fill="var(--background-modifier-border)" opacity="0.35" />
  <path d="M 25 122 Q 70 108 120 116 T 165 114 L 165 128 L 25 128 Z" fill="var(--background-modifier-border)" opacity="0.5" />

  <!-- Artisanal Teapot -->
  <!-- Teapot Spout -->
  <path d="M 52 76 C 36 68 34 50 44 44 C 47 42 50 46 45 52 C 38 60 48 70 56 74 Z" fill="url(#${potGradId})" stroke="var(--background-modifier-border)" stroke-width="1.4" />
  <!-- Teapot Handle -->
  <path d="M 112 62 C 132 62 132 92 110 94" fill="none" stroke="var(--background-modifier-border)" stroke-width="5" stroke-linecap="round" />
  <path d="M 112 64 C 128 64 128 90 110 92" fill="none" stroke="var(--background-primary)" stroke-width="2" />
  <!-- Teapot Main Vessel -->
  <ellipse cx="82" cy="78" rx="34" ry="26" fill="url(#${potGradId})" stroke="var(--background-modifier-border)" stroke-width="1.5" />
  <!-- Teapot Lid & Finial Knob -->
  <ellipse cx="82" cy="54" rx="19" ry="5.5" fill="url(#${potGradId})" stroke="var(--background-modifier-border)" stroke-width="1.4" />
  <ellipse cx="82" cy="48" rx="4.5" ry="4" fill="var(--interactive-accent)" />
  <!-- Teapot Leaf Crest -->
  <path d="M 82 72 C 77 66 75 74 82 82 C 89 74 87 66 82 72 Z" fill="url(#${accentLeafId})" opacity="0.85" />

  <!-- Companion Steaming Teacup -->
  <!-- Saucer -->
  <ellipse cx="132" cy="106" rx="22" ry="4.5" fill="var(--background-modifier-border)" opacity="0.7" />
  <ellipse cx="132" cy="104" rx="19" ry="3.5" fill="url(#${potGradId})" stroke="var(--background-modifier-border)" stroke-width="1" />
  <!-- Cup Handle -->
  <path d="M 144 88 C 153 88 153 98 142 100" fill="none" stroke="var(--background-modifier-border)" stroke-width="2.2" stroke-linecap="round" />
  <!-- Cup Body -->
  <path d="M 118 84 C 119 96 123 103 132 103 C 141 103 145 96 146 84 Z" fill="url(#${potGradId})" stroke="var(--background-modifier-border)" stroke-width="1.2" />
  <!-- Tea Liquid -->
  <ellipse cx="132" cy="84" rx="14" ry="4.5" fill="url(#${potGradId})" stroke="var(--background-modifier-border)" stroke-width="1.2" />
  <ellipse cx="132" cy="85" rx="12" ry="3.5" fill="url(#${amberTeaId})" />
  <!-- Floating Tea Leaf -->
  <path d="M 132 84 C 130 83 129 84.5 131 85.5 C 133 86 134 85 132 84 Z" fill="#22c55e" />

  <!-- Fragrant Steam Wisps -->
  <path d="M 127 78 Q 124 72 128 67 T 126 60" fill="none" stroke="var(--text-muted)" stroke-width="1.2" stroke-linecap="round" opacity="0.4" />
  <path d="M 134 77 Q 138 71 133 66 T 136 58" fill="none" stroke="var(--text-muted)" stroke-width="1.2" stroke-linecap="round" opacity="0.5" />
  <!-- Teapot Spout Steam -->
  <path d="M 44 42 Q 40 34 46 28 T 43 20" fill="none" stroke="var(--text-muted)" stroke-width="1.4" stroke-linecap="round" opacity="0.45" />

  <!-- Floating Darjeeling Tea Leaf Motifs in Air -->
  <g opacity="0.75">
    <path d="M 28 50 C 23 44 26 40 32 44 C 36 47 34 53 28 50 Z" fill="url(#${accentLeafId})" />
    <path d="M 152 46 C 156 40 161 43 158 48 C 155 52 149 50 152 46 Z" fill="url(#${accentLeafId})" />
    <path d="M 72 26 C 68 20 73 17 78 22 C 81 25 77 30 72 26 Z" fill="url(#${accentLeafId})" opacity="0.6" />
  </g>
</svg>
`.trim();
}

/**
 * Creates the chat empty state hero SVGSVGElement with unique instance IDs.
 */
export function createChatEmptyState(): SVGSVGElement {
  return parseSvgElement(getChatEmptyStateSvg());
}

/**
 * Artisanal illustration for the Plan Empty State.
 * Features an architectural scroll, drafting compass, and tea leaf seal.
 */
export function getPlanEmptyStateSvg(): string {
  const planBgId = nextId("dj-plan-bg");
  const scrollPaperId = nextId("dj-scroll-paper");

  return `
<svg class="dj-hero-illustration" width="160" height="130" viewBox="0 0 160 130" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="${planBgId}" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="var(--interactive-accent)" stop-opacity="0.12" />
      <stop offset="100%" stop-color="var(--background-secondary)" stop-opacity="0.3" />
    </linearGradient>
    <linearGradient id="${scrollPaperId}" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="var(--background-secondary)" />
      <stop offset="100%" stop-color="var(--background-secondary-alt, var(--background-modifier-border))" />
    </linearGradient>
  </defs>

  <!-- Ambient Glow -->
  <circle cx="80" cy="65" r="54" fill="url(#${planBgId})" />

  <!-- Rolled Execution Plan Scroll -->
  <rect x="36" y="24" width="88" height="82" rx="6" fill="url(#${scrollPaperId})" stroke="var(--background-modifier-border)" stroke-width="1.5" />
  <path d="M 36 34 L 124 34" stroke="var(--background-modifier-border)" stroke-width="1" opacity="0.6" />

  <!-- Blueprint Grid / Task Lines -->
  <line x1="46" y1="46" x2="68" y2="46" stroke="var(--interactive-accent)" stroke-width="2.5" stroke-linecap="round" />
  <line x1="74" y1="46" x2="114" y2="46" stroke="var(--text-muted)" stroke-width="1.8" stroke-linecap="round" opacity="0.5" />

  <rect x="46" y="58" width="8" height="8" rx="2" fill="none" stroke="var(--interactive-accent)" stroke-width="1.5" />
  <line x1="60" y1="62" x2="114" y2="62" stroke="var(--text-muted)" stroke-width="1.6" stroke-linecap="round" opacity="0.5" />

  <rect x="46" y="74" width="8" height="8" rx="2" fill="var(--interactive-accent)" opacity="0.8" />
  <path d="M 48 78 L 50 80 L 53 76" stroke="var(--text-on-accent, #fff)" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
  <line x1="60" y1="78" x2="108" y2="78" stroke="var(--text-muted)" stroke-width="1.6" stroke-linecap="round" opacity="0.7" />

  <rect x="46" y="90" width="8" height="8" rx="2" fill="none" stroke="var(--background-modifier-border)" stroke-width="1.5" />
  <line x1="60" y1="94" x2="98" y2="94" stroke="var(--text-muted)" stroke-width="1.6" stroke-linecap="round" opacity="0.4" />

  <!-- Drafting Compass / Pen Tool -->
  <path d="M 112 18 L 134 40 L 130 44 L 108 22 Z" fill="var(--interactive-accent)" opacity="0.9" />
  <path d="M 108 22 L 102 16 L 106 20 Z" fill="var(--text-normal)" />
  <circle cx="123" cy="29" r="2" fill="var(--text-on-accent, #fff)" />

  <!-- Artisanal Tea Leaf Seal / Wax Stamp -->
  <circle cx="114" cy="94" r="10" fill="#dc2626" opacity="0.85" />
  <circle cx="114" cy="94" r="8" fill="#b91c1c" />
  <path d="M 114 89 C 111 86 110 92 114 97 C 118 92 117 86 114 89 Z" fill="#fef2f2" opacity="0.9" />
</svg>
`.trim();
}

/**
 * Creates the plan empty state hero SVGSVGElement with unique instance IDs.
 */
export function createPlanEmptyState(): SVGSVGElement {
  return parseSvgElement(getPlanEmptyStateSvg());
}

/**
 * Minimalist botanical tea leaf branch illustration ("Two leaves and a bud").
 * Classic Darjeeling harvest emblem.
 */
export function getTeaLeafBranchSvg(size: number = 24): string {
  return `
<svg class="dj-tea-branch-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <!-- Central Stem -->
  <path d="M 4 21 C 8 18 11 14 13 8 C 13.5 6 13.8 4 14 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
  <!-- Left Mature Leaf -->
  <path d="M 10 15 C 5 14 3 10 5 7 C 8 8 11 11 11 13" fill="var(--dj-accent-leaf-grad, currentColor)" fill-opacity="0.25" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
  <!-- Right Delicate Leaf -->
  <path d="M 12 10 C 16 9 19 6 18 3 C 15 4 13 7 13 9" fill="var(--dj-accent-leaf-grad, currentColor)" fill-opacity="0.25" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
  <!-- Center Tender Bud -->
  <path d="M 13.5 5 C 13.5 3 14 2 15 2 C 15 3.5 14.2 4.8 13.5 5 Z" fill="currentColor" opacity="0.9" />
</svg>
`.trim();
}

/**
 * Creates the botanical tea leaf branch SVGSVGElement.
 */
export function createTeaLeafBranch(size: number = 24): SVGSVGElement {
  return parseSvgElement(getTeaLeafBranchSvg(size));
}
