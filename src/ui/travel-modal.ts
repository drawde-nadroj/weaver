/**
 * Travel: one centred card, the only navigation.
 *
 * It is a self-mounted overlay rather than a `Modal` for two reasons: it must sit
 * inside the note pane's geometry, and it must never take a `Scope` — a scope is
 * what swallowed `Mod+,` and stopped Obsidian's own settings from opening. Keys
 * reach Obsidian untouched unless they are one of the six this card uses.
 */

import type { MarkdownView } from "obsidian";

import { dimensionColorVars } from "../core/color";
import {
  clampCursor,
  moveDay,
  moveRow,
  parseDcnQuery,
  travelDays,
  type TravelDay,
  type TravelFilter,
  type TravelRow
} from "../core/travel-model";
import { TRAVEL_HINT } from "../notices";
import type WeaverPlugin from "../main";
import { appendDigitRuns } from "./dcn";
import { isPhone } from "./platform";

/** The six keys the card owns; everything else is Obsidian's. */
const HANDLED = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter", "Escape"]);

const PLACEHOLDER = "1 · 1.2 · .14 · 1.2.14";

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export class TravelModal {
  private readonly root: HTMLElement;
  private readonly card: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly daysEl: HTMLElement;
  private readonly rowsEl: HTMLElement;

  private rows: readonly TravelRow[] = [];
  private days: TravelDay[] = [];
  private filter: TravelFilter | null = null;
  private cursor = { day: 0, row: 0 };
  private opened = false;
  private observer: ResizeObserver | null = null;

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    // A chord belongs to Obsidian: not prevented, not seen, not swallowed.
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (!HANDLED.has(event.key)) return;

    event.preventDefault();
    event.stopPropagation();

    switch (event.key) {
      case "ArrowLeft":
        this.step(-1, 0);
        return;
      case "ArrowRight":
        this.step(1, 0);
        return;
      case "ArrowUp":
        this.step(0, -1);
        return;
      case "ArrowDown":
        this.step(0, 1);
        return;
      case "Enter":
        this.commit();
        return;
      default:
        this.escape();
    }
  };

  private readonly onOutside = (event: MouseEvent): void => {
    const target = event.target;
    if (target instanceof Node && this.card.contains(target as Node)) return;
    this.close();
  };

  private readonly onResize = (): void => {
    this.recenter();
  };

  constructor(
    private readonly plugin: WeaverPlugin,
    private readonly anchor: MarkdownView | null
  ) {
    this.root = document.createElement("div");
    this.root.className = "weaver-travel-modal";

    this.card = document.createElement("div");
    this.card.className = "weaver-travel-card";
    this.root.appendChild(this.card);

    this.input = document.createElement("input");
    this.input.className = "weaver-travel-query";
    this.input.setAttribute("type", "text");
    this.input.setAttribute("autocomplete", "off");
    this.input.setAttribute("spellcheck", "false");
    this.input.setAttribute("placeholder", PLACEHOLDER);
    this.card.appendChild(this.input);

    this.daysEl = document.createElement("div");
    this.daysEl.className = "weaver-travel-days";
    this.card.appendChild(this.daysEl);

    this.rowsEl = document.createElement("div");
    this.rowsEl.className = "weaver-travel-rows";
    this.card.appendChild(this.rowsEl);

    const hint = document.createElement("div");
    hint.className = "weaver-travel-hint";
    hint.textContent = TRAVEL_HINT;
    this.card.appendChild(hint);
  }

  get isOpen(): boolean {
    return this.opened;
  }

  open(rows: readonly TravelRow[] = []): void {
    // Nothing keeps ticking behind the card.
    this.plugin.entries.pause(new Date());

    this.rows = rows;
    this.filter = null;
    this.input.value = "";
    this.days = travelDays(rows, null);
    this.cursor = clampCursor(this.days, 0, 0);

    if (!this.opened) {
      document.body.appendChild(this.root);
      this.card.addEventListener("keydown", this.onKeyDown, true);
      document.addEventListener("mousedown", this.onOutside);
      window.addEventListener("resize", this.onResize);
      window.visualViewport?.addEventListener("resize", this.onResize);
      window.visualViewport?.addEventListener("scroll", this.onResize);

      this.observer = new ResizeObserver(() => this.recenter());
      this.observer.observe(this.anchor?.contentEl ?? this.root);
      this.opened = true;
    }

    this.render();
    this.recenter();
    this.input.focus();
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;

    this.card.removeEventListener("keydown", this.onKeyDown, true);
    document.removeEventListener("mousedown", this.onOutside);
    window.removeEventListener("resize", this.onResize);
    window.visualViewport?.removeEventListener("resize", this.onResize);
    window.visualViewport?.removeEventListener("scroll", this.onResize);
    this.observer?.disconnect();
    this.observer = null;
    this.root.remove();

    this.plugin.activeMarkdownView()?.editor?.focus();
  }

  /** Centres the card in the note pane, or in the visible viewport on a phone. */
  recenter(): void {
    if (!this.opened) return;

    const rect = isPhone() ? this.viewportRect() : this.anchorRect();
    this.root.style.left = `${rect.left + rect.width / 2}px`;
    this.root.style.top = `${rect.top + rect.height / 2}px`;
  }

  private anchorRect(): Rect {
    const element = this.anchor?.contentEl;
    if (element === undefined) return this.viewportRect();

    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }

  /** The part of the screen the soft keyboard has not covered. */
  private viewportRect(): Rect {
    const viewport = window.visualViewport;
    if (viewport !== undefined && viewport !== null && viewport.height > 0) {
      return {
        left: viewport.offsetLeft ?? 0,
        top: viewport.offsetTop ?? 0,
        width: viewport.width ?? window.innerWidth,
        height: viewport.height
      };
    }
    return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  }

  private step(dayDelta: number, rowDelta: number): void {
    this.cursor =
      rowDelta === 0
        ? moveDay(this.days, this.cursor.day, this.cursor.row, dayDelta)
        : moveRow(this.days, this.cursor.day, this.cursor.row, rowDelta);
    this.render();
  }

  /** `Enter`: lock a query, or travel to the selected draft. */
  private commit(): void {
    const text = this.input.value;

    if (text.trim() === "") {
      this.travel();
      return;
    }

    const filter = parseDcnQuery(text);
    // Unparseable is not a command: the card stays open with the text intact.
    if (filter === null) return;

    this.filter = filter;
    this.input.value = "";
    this.regroup();
  }

  private escape(): void {
    if (this.input.value.trim() !== "" || this.filter !== null) {
      this.input.value = "";
      this.filter = null;
      this.regroup();
      return;
    }
    this.close();
  }

  private regroup(): void {
    this.days = travelDays(this.rows, this.filter);
    this.cursor = clampCursor(this.days, this.cursor.day, this.cursor.row);
    this.render();
  }

  private travel(): void {
    const row = this.days[this.cursor.day]?.rows[this.cursor.row];
    this.close();
    if (row === undefined) return;
    void this.plugin.entries.travelTo(row);
  }

  private render(): void {
    this.daysEl.textContent = "";
    this.rowsEl.textContent = "";

    this.days.forEach((day, index) => {
      const chip = document.createElement("button");
      chip.className = index === this.cursor.day ? "weaver-travel-day is-current" : "weaver-travel-day";
      chip.textContent = `${day.key.replace(/-/g, ".")} · ${day.rows.length}`;
      chip.addEventListener("click", () => {
        this.cursor = clampCursor(this.days, index, this.cursor.row);
        this.render();
      });
      this.daysEl.appendChild(chip);
    });

    const rows = this.days[this.cursor.day]?.rows ?? [];
    rows.forEach((row, index) => {
      const button = document.createElement("button");
      button.className = index === this.cursor.row ? "weaver-travel-row is-current" : "weaver-travel-row";
      button.setAttribute("style", dimensionColorVars(row.d));

      const dcn = document.createElement("span");
      dcn.className = "weaver-travel-dcn";
      appendDigitRuns(dcn, `${row.d}.${row.c}.${row.n}`);
      button.appendChild(dcn);

      const time = document.createElement("span");
      time.className = "weaver-travel-time";
      time.textContent = row.time;
      button.appendChild(time);

      if (row.title !== "") {
        const title = document.createElement("span");
        title.className = "weaver-travel-title";
        title.textContent = row.title;
        button.appendChild(title);
      }

      button.addEventListener("click", () => {
        this.cursor = clampCursor(this.days, this.cursor.day, index);
        this.travel();
      });

      this.rowsEl.appendChild(button);
    });
  }
}
