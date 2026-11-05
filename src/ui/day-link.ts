/**
 * The link to the current day's note at the top right of a frame: `[[YYYY.MM.DD]]`.
 *
 * It is generated, not in the file, because it is a way back to today rather than
 * one of the note's entries. On a note that is not today's it names the *current*
 * date, not the note's own day. The `weaver-frame-label` class is what cuts the top
 * rail behind it, so it reads as the fourth corner label rather than a second
 * rendering of the marker row. Both surfaces build the same element here, so the
 * live preview and the reading view cannot drift apart.
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
