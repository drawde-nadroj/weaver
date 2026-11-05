/**
 * The entry-day link at the top right of a frame: `[[YYYY.MM.DD]]`.
 *
 * The entry's clock row records its day when one was written; a historical
 * undated row inherits the day-note filename, and the label is written in that
 * filename's own dotted or dashed style. This generated label names that
 * recorded day, never the date of viewing. The `weaver-frame-label` background
 * cuts the top rail behind it. Both surfaces build the same element here, so
 * Live Preview and Reading view agree.
 *
 * The element is a span with `role="link"`, not an anchor: the surfaces own the
 * navigation — `openLinkText` — and an anchor would let Obsidian's own handler
 * fire a second navigation on top of it.
 */

/** Open a day note by its basename, relative to the note on screen. */
export type OpenDayLink = (target: string, sourcePath: string) => void;

/**
 * The link element for `target` (`2026.11.02`), opened from `sourcePath`.
 *
 * A click or Enter/Space activates it; the event is stopped so the editor does
 * not also move the caret into the widget. `open` is called with the target and
 * the note it was clicked from, exactly as `workspace.openLinkText` wants them.
 */
export function dayLinkElement(
  target: string,
  sourcePath: string,
  open: OpenDayLink
): HTMLElement {
  const link = document.createElement("span");
  link.className = "weaver-entry-daylink weaver-frame-label";
  link.textContent = `[[${target}]]`;
  link.setAttribute("role", "link");
  link.setAttribute("tabindex", "0");
  link.setAttribute("aria-label", `Open the day note ${target}`);

  const activate = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
    open(target, sourcePath);
  };

  link.addEventListener("click", activate);
  link.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") activate(event);
  });

  return link;
}
