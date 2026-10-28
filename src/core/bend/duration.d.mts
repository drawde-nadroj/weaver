/**
 * The generated ES module: `npm run bend:build` writes `duration.mjs` from
 * `duration.bend`.
 *
 * `bend -o x.mjs` emits one default export object holding the module's non-IO
 * defs, so the facade imports that object and names the two it uses. Only the
 * counted defs are declared here: the rest are internal to the algebra.
 */
declare const duration: {
  /** Seconds -> `HH:MM:SS`; hours are as wide as a U32 allows. */
  clock(s: number): string;
  /** `HH:MM:SS` -> seconds + 1, or 0 when the text is not that shape. */
  parseClock(text: string): number;
};

export default duration;
