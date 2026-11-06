/**
 * Colour is a pure function of the dimension number.
 *
 * Level `d` is a colour that never depends on the vault, a setting, or another
 * level: `dimensionColor(7)` has the same value before and after a level 7 entry
 * exists anywhere. That is the whole fix — the old palette re-spread the ramp
 * whenever the vault found a deeper level, so the colour visibly jumped.
 *
 * Levels 1–6 are the anchors. Past them the path continues as an OKLCH spiral:
 * every nine steps the hue lands back on the purple anchor at a lower lightness,
 * so level 16 is still distinguishable from level 7.
 */

/** The six anchor colours: red, orange, yellow, green, blue, purple. */
export const ANCHORS = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#3b82f6",
  "#a855f7"
] as const;

/** Hue the spiral starts from: the purple anchor's. */
const SPIRAL_HUE = 300;
const SPIRAL_STEP = 40;
const SPIRAL_TURN = 9;

/** One sRGB channel to linear light, the first step into OKLab. */
export function srgbToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
}

/** The inverse: linear light back to an sRGB channel. */
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

/** OKLCH to `#rrggbb`, through {@link oklabToHex}. */
function oklchToHex(L: number, chroma: number, hue: number): string {
  const radians = (hue * Math.PI) / 180;
  return oklabToHex(L, chroma * Math.cos(radians), chroma * Math.sin(radians));
}

function compute(level: number): string {
  const anchor = ANCHORS[level - 1];
  if (anchor !== undefined) return anchor;

  const step = level - 7;
  const turn = Math.floor(step / SPIRAL_TURN);
  const hue = (SPIRAL_HUE + SPIRAL_STEP * (step % SPIRAL_TURN)) % 360;
  const lightness = Math.max(0.48, 0.7 - 0.05 * turn);
  const chroma = Math.max(0.08, 0.17 - 0.012 * turn);
  return oklchToHex(lightness, chroma, hue);
}

const cache = new Map<number, string>();

/** The colour of dimension `d`, memoised. Pure: nothing else is read. */
export function dimensionColor(d: number): string {
  const level = Number.isFinite(d) ? Math.max(1, Math.round(d)) : 1;
  const cached = cache.get(level);
  if (cached !== undefined) return cached;

  const color = compute(level);
  cache.set(level, color);
  return color;
}

/** The two custom properties a line or address carries: colour and depth. */
export function dimensionColorVars(d: number): string {
  const level = Number.isFinite(d) ? Math.max(1, Math.round(d)) : 1;
  return `--weaver-dcolor:${dimensionColor(level)};--weaver-d:${level}`;
}
