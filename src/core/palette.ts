import { isValidHeadingSize, type ColorMode, type WeaverSettings } from "../settings";

/**
 * The six anchor colors: red, orange, yellow, green, blue, purple. Every
 * palette Weaver generates is derived from this path.
 */
export const ANCHORS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#3b82f6", "#a855f7"] as const;

const DEEP_FALLBACK_TRANSITION_MS = 200;

export function srgbToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(channel: number): number {
  return channel <= 0.0031308 ? channel * 12.92 : 1.055 * Math.pow(channel, 1 / 2.4) - 0.055;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Converts `#rrggbb` to OKLab. Inverse of {@link oklabToHex}. */
export function hexToOklab(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const r = srgbToLinear(parseInt(clean.slice(0, 2), 16) / 255);
  const g = srgbToLinear(parseInt(clean.slice(2, 4), 16) / 255);
  const b = srgbToLinear(parseInt(clean.slice(4, 6), 16) / 255);

  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const lRoot = Math.cbrt(l);
  const mRoot = Math.cbrt(m);
  const sRoot = Math.cbrt(s);

  return [
    0.2104542553 * lRoot + 0.793617785 * mRoot - 0.0040720468 * sRoot,
    1.9779984951 * lRoot - 2.428592205 * mRoot + 0.4505937099 * sRoot,
    0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.808675766 * sRoot
  ];
}

function channelToHex(value: number): string {
  const byte = Math.round(clamp01(value) * 255);
  return byte.toString(16).padStart(2, "0");
}

/** Converts OKLab to `#rrggbb`, clamping out-of-gamut channels. */
export function oklabToHex(L: number, a: number, b: number): string {
  const lRoot = L + 0.3963377774 * a + 0.2158037573 * b;
  const mRoot = L - 0.1055613458 * a - 0.0638541728 * b;
  const sRoot = L - 0.0894841775 * a - 1.291485548 * b;

  const l = lRoot * lRoot * lRoot;
  const m = mRoot * mRoot * mRoot;
  const s = sRoot * sRoot * sRoot;

  const r = linearToSrgb(clamp01(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s));
  const g = linearToSrgb(clamp01(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s));
  const blue = linearToSrgb(clamp01(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s));

  return `#${channelToHex(r)}${channelToHex(g)}${channelToHex(blue)}`;
}

/**
 * Spreads the six anchors across `n` levels by sampling the anchor path in
 * OKLab. `n === 6` returns the anchors untouched.
 */
export function vaultStretch(n: number): string[] {
  const count = Math.max(6, Math.round(n));
  const labs = ANCHORS.map((anchor) => hexToOklab(anchor));
  const segments = labs.length - 1;
  const colors: string[] = [];

  for (let level = 1; level <= count; level += 1) {
    const t = (level - 1) / (count - 1);
    const position = t * segments;
    const index = Math.min(Math.floor(position), segments - 1);
    const from = labs[index] ?? labs[0] ?? [0, 0, 0];
    const to = labs[index + 1] ?? from;
    const fraction = position - index;
    colors.push(
      oklabToHex(
        from[0] + (to[0] - from[0]) * fraction,
        from[1] + (to[1] - from[1]) * fraction,
        from[2] + (to[2] - from[2]) * fraction
      )
    );
  }

  return colors;
}

/**
 * The fixed palette: exact anchors for H1–H6, then a geometric approach toward
 * the purple anchor for deeper levels.
 */
export function fixedExtension(level: number): string {
  const anchor = ANCHORS[level - 1];
  if (anchor !== undefined) return anchor;

  const p5 = hexToOklab(ANCHORS[4]);
  const p6 = hexToOklab(ANCHORS[5]);
  const factor = 1 - Math.pow(2, -(level - 6));
  return oklabToHex(
    p6[0] + (p6[0] - p5[0]) * factor,
    p6[1] + (p6[1] - p5[1]) * factor,
    p6[2] + (p6[2] - p5[2]) * factor
  );
}

/**
 * Builds exactly `maxDepth` colors. `vault-stretch` spreads the anchors across
 * the deepest heading the vault actually contains; `fixed-anchor` keeps H1–H6
 * anchored and extends past them.
 */
export function computePalette(mode: ColorMode, vaultMaxLevel: number, maxDepth: number): string[] {
  const depth = Math.max(1, Math.round(maxDepth));
  if (mode === "fixed-anchor") {
    return Array.from({ length: depth }, (_, index) => fixedExtension(index + 1));
  }

  const n = Math.min(Math.max(Math.max(6, Math.round(vaultMaxLevel)), 6), depth);
  const stretched = vaultStretch(n);
  const colors = stretched.slice(0, depth);

  for (let level = colors.length + 1; level <= depth; level += 1) {
    colors.push(fixedExtension(level));
  }
  return colors;
}

function indentPadding(level: number, indentMaxLevel: number): string {
  const steps = Math.max(0, Math.min(level - 1, indentMaxLevel - 1));
  return `calc(${steps} * var(--weaver-indent-step))`;
}

/**
 * Generates the single stylesheet body injected into `<style id="weaver-palette">`.
 * It carries the per-level colors, the H1–H6 `--hN-color` mapping, the
 * typography and indentation variables, and the per-level rules.
 */
export function paletteCss(settings: WeaverSettings, palette: readonly string[]): string {
  const depth = Math.max(1, Math.min(Math.round(settings.maxDepth), palette.length));
  const indentMax = Math.max(1, Math.min(settings.indentMaxLevel, depth));
  const weight = Math.round(settings.headingWeight);
  const transition = Math.max(
    0,
    Number.isFinite(settings.paletteTransitionMs)
      ? Math.round(settings.paletteTransitionMs)
      : DEEP_FALLBACK_TRANSITION_MS
  );

  const variables: string[] = [];
  for (let level = 1; level <= depth; level += 1) {
    variables.push(`--weaver-h${level}: ${palette[level - 1] ?? "#888888"};`);
  }
  for (let level = 1; level <= 6; level += 1) {
    variables.push(`--h${level}-color: var(--weaver-h${level});`);
  }
  variables.push(
    `--weaver-dimension-size: ${settings.headingSize};`,
    `--weaver-dimension-weight: ${weight};`,
    "--weaver-dimension-line-height: 1.35;",
    `--weaver-indent-step: ${Math.max(0, Math.round(settings.indentStep))}px;`,
    `--weaver-indent-step-mobile: ${Math.max(0, Math.round(settings.mobileIndentStep))}px;`,
    `--weaver-indent-max-level: ${indentMax};`,
    `--weaver-palette-transition: ${transition}ms;`
  );

  const rules: string[] = [
    `body {\n  ${variables.join("\n  ")}\n}`,
    "body.is-phone {\n  --weaver-indent-step: var(--weaver-indent-step-mobile);\n}"
  ];

  // Per-level sizes only apply when sizes are not equalized; equalizing is the
  // explicit "one size for every heading" mode.
  const sizeFor = (level: number): string | null => {
    if (settings.equalizeHeadingSizes) return null;
    const size = settings.headingLevelSizes?.[level];
    return typeof size === "string" && isValidHeadingSize(size) ? size.trim() : null;
  };

  for (let level = 1; level <= depth; level += 1) {
    const declarations = [
      `  padding-left: ${indentPadding(level, indentMax)};`
    ];
    const size = sizeFor(level);
    if (size !== null) declarations.push(`  font-size: ${size};`);

    if (level > 6) {
      // Deep headings are plain text lines that only Weaver turns into
      // dimensions, so one rule carries their colour, indent and size.
      rules.push(
        [
          `body .weaver-h${level},`,
          `body .markdown-rendered .weaver-dimension.weaver-h${level} {`,
          `  color: var(--weaver-h${level});`,
          ...declarations,
          "}"
        ].join("\n")
      );
      continue;
    }

    // Levels 1–6 are real Obsidian headings. The editor paints the heading text
    // on its own `cm-header-N` span, and a colour set on that span beats a colour
    // inherited from the line — so the span must be named for the level colour to
    // be deterministic in Live Preview instead of theme-dependent. Geometry stays
    // on the block-level selectors: padding or a size on the span would compound
    // with the line's own.
    rules.push(
      [
        `body .cm-header-${level},`,
        `body .HyperMD-header-${level},`,
        `body .markdown-rendered h${level},`,
        `body .weaver-h${level} {`,
        `  color: var(--weaver-h${level});`,
        "}"
      ].join("\n")
    );

    rules.push(
      [
        `body .HyperMD-header-${level},`,
        `body .markdown-rendered h${level},`,
        `body .weaver-h${level} {`,
        ...declarations,
        "}"
      ].join("\n")
    );
  }

  const transitions = [
    ...Array.from({ length: 6 }, (_, index) => `body .cm-header-${index + 1}`),
    ...Array.from({ length: 6 }, (_, index) => `body .markdown-rendered h${index + 1}`),
    "body .weaver-dimension-line"
  ];
  rules.push(
    `${transitions.join(",\n")} {\n  transition: color var(--weaver-palette-transition) ease;\n}`
  );

  rules.push(
    [
      "body:not(.weaver-no-emphasis) .markdown-rendered em,",
      "body:not(.weaver-no-emphasis) .cm-em {",
      `  color: ${ANCHORS[1]};`,
      "}",
      "body:not(.weaver-no-emphasis) .markdown-rendered strong,",
      "body:not(.weaver-no-emphasis) .cm-strong {",
      `  color: ${ANCHORS[0]};`,
      "}"
    ].join("\n")
  );

  return `${rules.join("\n\n")}\n`;
}
