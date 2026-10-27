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

export function isMobile(): boolean {
  const platform = Platform as unknown as { isMobile?: boolean };
  if (typeof platform.isMobile === "boolean") return platform.isMobile;
  return document.body.classList.contains("is-mobile");
}

export function isTablet(): boolean {
  const platform = Platform as unknown as { isTablet?: boolean };
  if (typeof platform.isTablet === "boolean") return platform.isTablet;
  return document.body.classList.contains("is-tablet");
}

/** True when the pointer can hover, so tooltips and hover states are useful. */
export function canHover(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(hover: hover)").matches;
}
