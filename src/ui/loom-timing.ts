/**
 * The loom's timing group: one beginning clock and one writing duration, in the
 * shared digit grammar — icon, white digits, dimension-coloured colons.
 *
 * An unknown value draws a single `—` over digit runs that stay in the DOM, so a
 * known value returns without rebuilding nodes. `update` paints one explicit
 * reading and reports whether the drawn duration changed; no timer, no clock.
 */

import { setIcon } from "obsidian";

import { formatClock } from "../core/duration";
import { writeClockText } from "../editor/duration-ticker";
import { appendClockRuns } from "./dcn";

/** What a timing group is showing. */
export type LoomTimingMode = "preview" | "running" | "paused" | "recorded" | "pending";

/** One explicit reading; the caller samples every field and supplies no clock. */
export interface LoomTimingReading {
  /** Canonical `HH:MM:SS` beginning, or null when it is not known. */
  time: string | null;
  /** Milliseconds elapsed, or null when the duration is not known. */
  durationMs: number | null;
  /** Which surface is speaking: preview, live, paused, recorded, or loading. */
  mode: LoomTimingMode;
}

/** The single character an unknown value draws, standing in for all six digits. */
const UNKNOWN_CLOCK = "—";

/** Labels and status word per mode; the one place wording lives. */
const LABELS: Record<
  LoomTimingMode,
  { begin: string; beginTitle: string; duration: string; durationTitle: string; state: string }
> = {
  preview: { begin: "Current time preview", beginTitle: "Current time preview — no input recorded yet", duration: "Writing duration", durationTitle: "Writing duration — nothing written yet", state: "" },
  running: { begin: "Beginning time", beginTitle: "The moment writing began", duration: "Writing duration", durationTitle: "Writing duration so far", state: "" },
  paused: { begin: "Beginning time", beginTitle: "The moment writing began", duration: "Writing duration", durationTitle: "Writing duration, paused", state: "Paused" },
  recorded: { begin: "Beginning time", beginTitle: "Beginning time recorded in the note", duration: "Recorded writing duration", durationTitle: "Writing duration recorded in the note", state: "" },
  pending: { begin: "Beginning time", beginTitle: "Reading the recorded beginning time…", duration: "Writing duration", durationTitle: "Reading the recorded writing duration…", state: "" }
};

/** One labelled clock: its digit runs, and the dash that stands in for them. */
interface ClockValue {
  el: HTMLElement;
  /** Digit runs' wrapper, hidden while the value is unknown. */
  host: HTMLElement;
  digits: readonly HTMLElement[];
  unknown: HTMLElement;
}

/** Shows or hides a node without touching its children. */
function toggle(el: HTMLElement, visible: boolean): void {
  if (visible) el.removeAttribute("hidden");
  else el.setAttribute("hidden", "");
}

/**
 * One timing group inside `parent`: beginning first, writing duration second.
 * Built once by the constructor; mounted wherever the timing belongs.
 */
export class LoomTiming {
  /** The group's root, appended to the parent by the constructor. */
  readonly dom: HTMLElement;

  private readonly beginValue: ClockValue;
  private readonly durationValue: ClockValue;
  private readonly state: HTMLElement;
  private lastDuration = "";

  constructor(parent: HTMLElement) {
    const doc: Document = parent.ownerDocument ?? document;

    this.dom = doc.createElement("div");
    this.dom.className = "weaver-composer-timing";
    this.dom.setAttribute("role", "timer");
    this.dom.setAttribute("aria-live", "off");

    this.beginValue = this.clock(doc, "beginning", "clock");
    this.durationValue = this.clock(doc, "duration", "timer");

    this.state = doc.createElement("span");
    this.state.className = "weaver-composer-timing-state";
    this.state.setAttribute("aria-hidden", "true");
    this.dom.appendChild(this.state);

    parent.appendChild(this.dom);
    this.update({ time: null, durationMs: 0, mode: "preview" });
  }

  /** Paints one reading; true only when the drawn duration changed. */
  update(reading: LoomTimingReading): boolean {
    const labels = LABELS[reading.mode];
    const duration = reading.durationMs === null ? null : formatClock(reading.durationMs);

    this.writeClock(this.beginValue, reading.time);
    this.writeClock(this.durationValue, duration);

    const durationText = duration ?? UNKNOWN_CLOCK;
    const changed = durationText !== this.lastDuration;
    this.lastDuration = durationText;
    const timeText = reading.time ?? UNKNOWN_CLOCK;
    this.beginValue.el.setAttribute("aria-label", labels.begin);
    this.beginValue.el.setAttribute("title", labels.beginTitle);
    this.durationValue.el.setAttribute("aria-label", labels.duration);
    this.durationValue.el.setAttribute("title", labels.durationTitle);

    this.state.textContent = labels.state;
    this.dom.setAttribute("data-mode", reading.mode);
    const paused = labels.state === "Paused" ? ", paused" : "";
    this.dom.setAttribute("aria-label", `${labels.begin} ${timeText}, ${labels.duration} ${durationText}${paused}`);
    return changed;
  }

  /** Builds one labelled clock: hidden icon, stable digit runs, stable dash. */
  private clock(doc: Document, kind: "beginning" | "duration", icon: "clock" | "timer"): ClockValue {
    const el = doc.createElement("span");
    el.className = "weaver-composer-timing-value";
    el.setAttribute("data-kind", kind);

    const iconEl = doc.createElement("span");
    iconEl.className = "weaver-composer-timing-icon";
    iconEl.setAttribute("aria-hidden", "true");
    setIcon(iconEl, icon);

    const host = doc.createElement("span");
    host.className = "weaver-composer-timing-digits";

    const unknown = doc.createElement("span");
    unknown.className = "weaver-composer-timing-unknown";
    unknown.textContent = UNKNOWN_CLOCK;
    unknown.setAttribute("aria-hidden", "true");

    el.appendChild(iconEl);
    el.appendChild(host);
    el.appendChild(unknown);
    this.dom.appendChild(el);

    // The runs are the shared clock grammar: white digits, coloured colons.
    return { el, host, digits: appendClockRuns(host, "00:00:00"), unknown };
  }

  /** Writes a clock into the stable digit spans, or swaps in the dash. */
  private writeClock(value: ClockValue, clock: string | null): void {
    toggle(value.host, clock !== null);
    toggle(value.unknown, clock === null);
    if (clock !== null) writeClockText(value.digits, clock);
  }
}
