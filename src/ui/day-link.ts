/**
 * The entry-day label at the top right of a frame.
 *
 * An entry in a dated note hides its redundant same-day label; an entry in an
 * ordinary note hides only a recorded day equal to the current local day. Every
 * other recorded day stays visible. When Weaver can resolve that day to a note,
 * the label is a `[[YYYY.MM.DD]]`-style link; otherwise it is static text. Both
 * forms cut the top rail through `weaver-frame-label`, and both surfaces build
 * them here so Live Preview and Reading view agree.
 *
 * An interactive label is a span with `role="link"`, not an anchor: the surfaces
 * own navigation through `openLinkText`, so the host never performs a second
 * navigation on top of it.
 */

import type { EntryDayLabel } from "../core/contexts";

/** Open a day note by its basename, relative to the note on screen. */
export type OpenDayLink = (target: string, sourcePath: string) => void;

/**
 * The top-right entry-day element.
 *
 * A resolved target is keyboard-accessible and opens through the owning surface.
 * An ordinary note can still show an older recorded day without inventing a
 * destination: that form is the same frame label, but intentionally static.
 */
export function entryDayElement(
  label: EntryDayLabel,
  sourcePath: string,
  open: OpenDayLink
): HTMLElement {
  const element = document.createElement("span");
  element.className = label.target === null
    ? "weaver-entry-daylabel weaver-frame-label"
    : "weaver-entry-daylink weaver-frame-label";
  element.textContent = label.target === null ? label.day : `[[${label.target}]]`;

  const target = label.target;
  if (target === null) {
    element.setAttribute("aria-label", `Recorded day ${label.day}`);
    return element;
  }

  element.setAttribute("role", "link");
  element.setAttribute("tabindex", "0");
  element.setAttribute("aria-label", `Open the day note ${target}`);

  const activate = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
    open(target, sourcePath);
  };

  element.addEventListener("click", activate);
  element.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") activate(event);
  });

  return element;
}
