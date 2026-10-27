import { StateEffect, StateField, type Extension } from "@codemirror/state";

import { parseHeadings, type HeadingIndex } from "../core/headings";

export const EMPTY_HEADING_INDEX: HeadingIndex = {
  headings: [],
  drafts: [],
  maxLevel: 0,
  codeFences: [],
  unclosedFence: false,
  unclosedFrontmatter: false,
  frontmatterEnd: null
};

/** Forces a reparse, used when a setting that affects parsing changes. */
export const refreshHeadingsEffect = StateEffect.define<void>();

let maxDepthProvider: () => number = () => 12;

function parseFromDoc(doc: string): HeadingIndex {
  return parseHeadings(doc, { maxDepth: maxDepthProvider() });
}

/**
 * The single heading index shared by decorations, travel, the dimension list and
 * the strip, so every surface agrees on structure.
 */
export const headingIndexField = StateField.define<HeadingIndex>({
  create: (state) => parseFromDoc(state.doc.toString()),
  update: (value, transaction) => {
    if (transaction.docChanged) return parseFromDoc(transaction.state.doc.toString());
    if (transaction.effects.some((effect) => effect.is(refreshHeadingsEffect))) {
      return parseFromDoc(transaction.state.doc.toString());
    }
    return value;
  }
});

export function headingIndexExtension(getMaxDepth: () => number): Extension {
  maxDepthProvider = () => {
    const depth = getMaxDepth();
    return Number.isFinite(depth) && depth > 0 ? Math.round(depth) : 12;
  };
  return headingIndexField;
}
