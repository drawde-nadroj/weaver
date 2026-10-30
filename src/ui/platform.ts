/**
 * Which platform this is, as one answer.
 *
 * Every surface asks here rather than reading Obsidian's flags itself, so a phone
 * is a phone in the CSS, in the keys and in the pinning alike.
 */

import { Platform } from "obsidian";

/**
 * Phone detection with the documented fallback: older runtimes may not expose
 * `Platform.isPhone`, in which case Obsidian's own body class is authoritative.
 */
export function isPhone(): boolean {
  const platform = Platform as unknown as { isPhone?: boolean };
  if (typeof platform.isPhone === "boolean") return platform.isPhone;
  return document.body.classList.contains("is-phone");
}

/** True on a phone or a tablet, from Obsidian's own flags. */
export function isMobile(): boolean {
  const platform = Platform as unknown as { isMobile?: boolean };
  if (typeof platform.isMobile === "boolean") return platform.isMobile;
  return document.body.classList.contains("is-mobile");
}

/** True on a tablet, which is neither a phone nor a desktop window. */
export function isTablet(): boolean {
  const platform = Platform as unknown as { isTablet?: boolean };
  if (typeof platform.isTablet === "boolean") return platform.isTablet;
  return document.body.classList.contains("is-tablet");
}

/** True when the pointer can hover, so tooltips and hover states are useful. */
export function canHover(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(hover: hover)").matches;
}
