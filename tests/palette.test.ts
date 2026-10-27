import { describe, expect, it } from "vitest";

import {
  ANCHORS,
  computePalette,
  fixedExtension,
  hexToOklab,
  linearToSrgb,
  oklabToHex,
  paletteCss,
  srgbToLinear,
  vaultStretch
} from "../src/core/palette";
import { DEFAULT_SETTINGS, type WeaverSettings } from "../src/settings";

const ALL_MAX = 12;

function settings(overrides: Partial<WeaverSettings> = {}): WeaverSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

interface CssRule {
  selectors: string[];
  declarations: string[];
}

/** Splits the emitted stylesheet into rules, so tests read the contract, not its layout. */
function cssRules(css: string): CssRule[] {
  return css
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.endsWith("}") && chunk.includes("{"))
    .map((chunk) => {
      const open = chunk.indexOf("{");
      const selectors = chunk
        .slice(0, open)
        .split("\n")
        .map((line) => line.replace(/,$/, "").trim())
        .filter((line) => line !== "");
      const declarations = chunk
        .slice(open + 1, chunk.lastIndexOf("}"))
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
      return { selectors, declarations };
    });
}

/** The declaration `property` for `selector`, or null when no rule carries it. */
function declaration(css: string, selector: string, property: string): string | null {
  for (const rule of cssRules(css)) {
    if (!rule.selectors.includes(selector)) continue;
    const found = rule.declarations.find((line) => line.startsWith(`${property}:`));
    if (found !== undefined) return found;
  }
  return null;
}

describe("OKLab conversion", () => {
  it("round-trips every anchor", () => {
    for (const anchor of ANCHORS) {
      expect(oklabToHex(...hexToOklab(anchor))).toBe(anchor);
    }
  });

  it("round-trips sRGB transfer functions", () => {
    for (const channel of [0, 0.02, 0.5, 0.9, 1]) {
      expect(linearToSrgb(srgbToLinear(channel))).toBeCloseTo(channel, 10);
    }
  });

  it("clamps out-of-gamut output instead of emitting invalid hex", () => {
    expect(oklabToHex(0, 0, 0)).toMatch(/^#[0-9a-f]{6}$/);
    expect(oklabToHex(1, 0, 0)).toBe("#ffffff");
    expect(oklabToHex(0, 0, 0)).toBe("#000000");
  });
});

describe("vaultStretch", () => {
  it("returns the exact anchors for six levels", () => {
    expect(vaultStretch(6)).toEqual([...ANCHORS]);
  });

  it("spreads eight levels across the anchor path", () => {
    expect(vaultStretch(8)).toEqual([
      "#ef4444",
      "#f6672a",
      "#f49012",
      "#d7b725",
      "#5cc458",
      "#23a4bf",
      "#6778f6",
      "#a855f7"
    ]);
  });

  it("keeps the anchors at the ends for any count", () => {
    for (const n of [6, 7, 8, 9, 12, 24]) {
      const colors = vaultStretch(n);
      expect(colors).toHaveLength(n);
      expect(colors[0]).toBe("#ef4444");
      expect(colors[n - 1]).toBe("#a855f7");
    }
  });

  it("never goes below six levels", () => {
    expect(vaultStretch(3)).toHaveLength(6);
  });
});

describe("fixedExtension", () => {
  it("returns the anchors for H1–H6", () => {
    expect(Array.from({ length: 6 }, (_, index) => fixedExtension(index + 1))).toEqual([...ANCHORS]);
  });

  it("extends past purple with a geometric approach", () => {
    expect(fixedExtension(7)).toBe("#ca24f7");
    expect([8, 9, 10, 11, 12].map(fixedExtension)).toEqual([
      "#d900f8",
      "#e100f8",
      "#e400f8",
      "#e600f8",
      "#e700f8"
    ]);
  });

  it("keeps extending for deeper levels", () => {
    expect(fixedExtension(20)).toMatch(/^#[0-9a-f]{6}$/);
    expect(fixedExtension(20)).not.toBe(fixedExtension(12));
  });
});

describe("computePalette", () => {
  it("always returns exactly maxDepth colors", () => {
    for (const maxDepth of [6, 8, 12, 24]) {
      expect(computePalette("vault-stretch", 5, maxDepth)).toHaveLength(maxDepth);
      expect(computePalette("fixed-anchor", 5, maxDepth)).toHaveLength(maxDepth);
    }
  });

  it("stretches across the vault depth, never below six", () => {
    expect(computePalette("vault-stretch", 5, ALL_MAX).slice(0, 6)).toEqual([...ANCHORS]);
    expect(computePalette("vault-stretch", 0, ALL_MAX).slice(0, 6)).toEqual([...ANCHORS]);
  });

  it("fills levels past the vault depth with the fixed extension", () => {
    const palette = computePalette("vault-stretch", 6, ALL_MAX);
    expect(palette.slice(6)).toEqual([7, 8, 9, 10, 11, 12].map(fixedExtension));
  });

  it("uses the stretch for the vault depth and the extension after it", () => {
    const palette = computePalette("vault-stretch", 8, ALL_MAX);
    expect(palette.slice(0, 8)).toEqual(vaultStretch(8));
    expect(palette.slice(8)).toEqual([9, 10, 11, 12].map(fixedExtension));
  });

  it("never stretches past maxDepth", () => {
    const palette = computePalette("vault-stretch", 20, 8);
    expect(palette).toEqual(vaultStretch(8));
    expect(palette[7]).toBe("#a855f7");
  });

  it("ignores the vault depth in fixed-anchor mode", () => {
    expect(computePalette("fixed-anchor", 12, ALL_MAX)).toEqual(
      Array.from({ length: ALL_MAX }, (_, index) => fixedExtension(index + 1))
    );
    expect(computePalette("fixed-anchor", 0, ALL_MAX)).toEqual(
      Array.from({ length: ALL_MAX }, (_, index) => fixedExtension(index + 1))
    );
  });
});

describe("paletteCss", () => {
  const palette = computePalette("vault-stretch", 8, ALL_MAX);
  const css = paletteCss(settings(), palette);

  it("emits every level variable and the H1–H6 mapping", () => {
    for (let level = 1; level <= ALL_MAX; level += 1) {
      expect(css).toContain(`--weaver-h${level}: ${palette[level - 1]};`);
    }
    for (let level = 1; level <= 6; level += 1) {
      expect(css).toContain(`--h${level}-color: var(--weaver-h${level});`);
    }
  });

  it("emits the typography, indentation and transition variables", () => {
    expect(css).toContain("--weaver-dimension-size: 1em;");
    expect(css).toContain("--weaver-dimension-weight: 600;");
    expect(css).toContain("--weaver-dimension-line-height: 1.35;");
    expect(css).toContain("--weaver-indent-step: 18px;");
    expect(css).toContain("--weaver-indent-step-mobile: 12px;");
    expect(css).toContain("--weaver-indent-max-level: 8;");
    expect(css).toContain("--weaver-palette-transition: 200ms;");
    expect(css).toContain("body.is-phone {");
  });

  it("caps indentation at indentMaxLevel", () => {
    const capped = paletteCss(settings({ indentMaxLevel: 3 }), palette);
    expect(declaration(capped, "body .markdown-rendered h3", "padding-left")).toBe(
      "padding-left: calc(2 * var(--weaver-indent-step));"
    );
    expect(declaration(capped, "body .markdown-rendered h6", "padding-left")).toBe(
      "padding-left: calc(2 * var(--weaver-indent-step));"
    );
    expect(declaration(capped, "body .markdown-rendered h1", "padding-left")).toBe(
      "padding-left: calc(0 * var(--weaver-indent-step));"
    );
  });

  it("scales indentation per level", () => {
    expect(declaration(css, "body .markdown-rendered h1", "padding-left")).toBe(
      "padding-left: calc(0 * var(--weaver-indent-step));"
    );
    expect(declaration(css, "body .markdown-rendered h2", "padding-left")).toBe(
      "padding-left: calc(1 * var(--weaver-indent-step));"
    );
    expect(declaration(css, "body .weaver-h7", "padding-left")).toBe(
      "padding-left: calc(6 * var(--weaver-indent-step));"
    );
  });

  it("colours the editor's heading spans, not only the line", () => {
    expect(css).toContain("body .cm-header-1,");
    expect(css).toContain("body .HyperMD-header-3,");

    for (let level = 1; level <= 6; level += 1) {
      expect(declaration(css, `body .cm-header-${level}`, "color")).toBe(
        `color: var(--weaver-h${level});`
      );
      expect(declaration(css, `body .HyperMD-header-${level}`, "color")).toBe(
        `color: var(--weaver-h${level});`
      );
      // Geometry stays on the block so it cannot compound with the line's own.
      expect(declaration(css, `body .cm-header-${level}`, "padding-left")).toBeNull();
      expect(declaration(css, `body .cm-header-${level}`, "font-size")).toBeNull();
    }
  });

  it("uses body-prefixed selectors so theme heading rules cannot win", () => {
    expect(css).toContain("body .weaver-h1 {");
    expect(css).toContain("body .HyperMD-header-1,");
    expect(css).toContain("body .markdown-rendered h1,");
    expect(css).not.toMatch(/^\.weaver-h1/m);
    expect(css).not.toMatch(/^\.cm-header-1/m);
  });

  it("port colours only when emphasis forwarding is on", () => {
    expect(css).toContain("body:not(.weaver-no-emphasis) .markdown-rendered em,");
    expect(css).toContain("body:not(.weaver-no-emphasis) .markdown-rendered strong,");
    expect(css).toContain("#f97316");
    expect(css).toContain("#ef4444");
  });

  it("contains no NaN or undefined values", () => {
    expect(css).not.toContain("NaN");
    expect(css).not.toContain("undefined");
    expect(css).not.toContain("null");
  });

  it("omits per-level sizes while heading sizes are equalized", () => {
    const equalized = paletteCss(settings(), palette);
    expect(equalized).not.toContain("font-size: 1.5em;");
  });

  it("emits per-level sizes when sizes are not equalized", () => {
    const custom = paletteCss(
      settings({
        equalizeHeadingSizes: false,
        headingLevelSizes: { 2: "1.5em", 7: "0.9rem", 4: "bogus" }
      }),
      palette
    );

    expect(declaration(custom, "body .markdown-rendered h2", "padding-left")).toBe(
      "padding-left: calc(1 * var(--weaver-indent-step));"
    );
    expect(declaration(custom, "body .markdown-rendered h2", "font-size")).toBe("font-size: 1.5em;");
    expect(custom).toContain(
      "body .weaver-h7,\nbody .markdown-rendered .weaver-dimension.weaver-h7 {\n  color: var(--weaver-h7);\n  padding-left: calc(6 * var(--weaver-indent-step));\n  font-size: 0.9rem;\n}"
    );
    // An invalid size is dropped rather than written as broken CSS.
    expect(custom).not.toContain("bogus");
    expect(declaration(custom, "body .markdown-rendered h4", "font-size")).toBeNull();
    expect(declaration(custom, "body .markdown-rendered h4", "padding-left")).toBe(
      "padding-left: calc(3 * var(--weaver-indent-step));"
    );
  });

  it("honours custom typography and indent settings", () => {
    const custom = paletteCss(
      settings({ headingSize: "1.25rem", headingWeight: 700, indentStep: 0, paletteTransitionMs: 0 }),
      palette
    );
    expect(custom).toContain("--weaver-dimension-size: 1.25rem;");
    expect(custom).toContain("--weaver-dimension-weight: 700;");
    expect(custom).toContain("--weaver-indent-step: 0px;");
    expect(custom).toContain("--weaver-palette-transition: 0ms;");
  });

  it("truncates to the shorter of settings and palette", () => {
    const short = paletteCss(settings(), palette.slice(0, 6));
    expect(short).toContain("--weaver-h6");
    expect(short).not.toContain("--weaver-h7");
  });
});
