
import { NOTE_GLYPH, SPARK_GLYPH, WORDS_GLYPH } from "../core/vocabulary";
import type WeaverPlugin from "../main";
import type { ShuttleItem } from "../shuttle/store";
import { isPhone } from "./platform";

const GLYPHS = {
  dimension: SPARK_GLYPH,
  note: NOTE_GLYPH,
  words: WORDS_GLYPH
} as const;

const HINT = "↵ weave in · ⌘↵ spark from it · ⌥↵ open · ⌫ unload · / filter · Esc close";

/**
 * The shuttle palette: the loaded sources, and the four verbs that act on them.
 *
 * It is an overlay, not a modal: the caret stays in the note underneath, so
 * weaving in lands where the writer already is. Weaving keeps the row and bumps
 * its use count; only `⌫` unloads.
 */
export class ShuttlePalette {
  private overlay: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private filterEl: HTMLInputElement | null = null;
  private selection = 0;

  constructor(private readonly plugin: WeaverPlugin) {}

  get isOpen(): boolean {
    return this.overlay !== null;
  }

  open(): void {
    if (this.overlay !== null) {
      this.filterEl?.focus();
      return;
    }

    const overlay = document.body.createDiv({ cls: "weaver-shuttle" });
    if (isPhone()) overlay.addClass("weaver-shuttle-phone");
    overlay.setAttr("role", "dialog");
    overlay.setAttr("aria-label", "Shuttle");

    const head = overlay.createDiv({ cls: "weaver-shuttle-head" });
    head.createSpan({ cls: "weaver-shuttle-title" });

    this.filterEl = head.createEl("input", {
      cls: "weaver-shuttle-filter",
      type: "search",
      placeholder: "Filter"
    });
    this.filterEl.setAttr("aria-label", "Filter the shuttle");
    this.filterEl.addEventListener("input", () => {
      this.selection = 0;
      this.paint();
    });

    this.listEl = overlay.createDiv({ cls: "weaver-shuttle-list" });
    this.listEl.setAttr("tabindex", "0");
    this.listEl.setAttr("role", "listbox");

    overlay.createDiv({ cls: "weaver-shuttle-hint", text: HINT });

    overlay.addEventListener("keydown", (event) => this.handleKey(event));
    document.body.appendChild(overlay);

    this.overlay = overlay;
    this.selection = 0;
    this.paint();
    this.filterEl.focus();
  }

  close(): void {
    this.overlay?.remove();
    this.overlay = null;
    this.listEl = null;
    this.filterEl = null;
  }

  private visible(): ShuttleItem[] {
    const query = (this.filterEl?.value ?? "").trim().toLowerCase();
    const items = this.plugin.shuttles.items();
    if (query === "") return [...items];
    return items.filter((item) => `${item.label}\n${item.path}`.toLowerCase().includes(query));
  }

  private paint(): void {
    const list = this.listEl;
    const overlay = this.overlay;
    if (list === null || overlay === null) return;

    const items = this.visible();
    this.selection = Math.min(this.selection, Math.max(0, items.length - 1));

    overlay.querySelector(".weaver-shuttle-title")?.setText(
      `Shuttle · ${this.plugin.shuttles.items().length} loaded`
    );

    list.empty();
    if (items.length === 0) {
      list.createDiv({
        cls: "weaver-shuttle-empty",
        text:
          this.plugin.shuttles.items().length === 0
            ? "Nothing loaded. Grab a source with ⌘⇧G."
            : "No loaded source matches."
      });
      return;
    }

    items.forEach((item, index) => {
      const selected = index === this.selection;
      const row = list.createEl("button", {
        cls: `weaver-shuttle-row${selected ? " is-selected" : ""}`
      });
      row.setAttr("role", "option");
      row.setAttr("aria-selected", selected ? "true" : "false");
      row.setAttr("data-shuttle-id", item.id);

      const glyph = row.createSpan({ cls: "weaver-shuttle-glyph" });
      glyph.setText(GLYPHS[item.kind]);
      row.createSpan({ cls: "weaver-shuttle-label", text: item.label });
      if (item.usedCount > 1) {
        row.createSpan({ cls: "weaver-shuttle-used", text: `·${item.usedCount}` });
      }
      row.createSpan({
        cls: "weaver-shuttle-day",
        text: item.addedAt.slice(0, 10)
      });

      row.addEventListener("click", () => {
        this.selection = index;
        this.paint();
      });
      row.addEventListener("dblclick", () => this.weave(item));
    });

    const remove = list.createEl("button", { cls: "weaver-shuttle-unload", text: "×" });
    remove.setAttr("aria-label", "Unload");
    const current = items[this.selection];
    if (current !== undefined && isPhone()) {
      remove.addEventListener("click", () => this.unload(current));
    } else {
      remove.remove();
    }

    this.scrollSelected();
  }

  private scrollSelected(): void {
    const row = this.listEl?.querySelectorAll(".weaver-shuttle-row")[this.selection];
    row?.scrollIntoView({ block: "nearest" });
  }

  private handleKey(event: KeyboardEvent): void {
    const items = this.visible();

    switch (event.key) {
      case "Escape":
        event.preventDefault();
        this.close();
        return;
      case "/":
        if (document.activeElement === this.filterEl) return;
        event.preventDefault();
        this.filterEl?.focus();
        return;
      case "ArrowDown":
      case "j":
        event.preventDefault();
        this.move(1, items.length);
        return;
      case "ArrowUp":
      case "k":
        event.preventDefault();
        this.move(-1, items.length);
        return;
      case "Enter": {
        event.preventDefault();
        const item = items[this.selection];
        if (item === undefined) return;
        if (event.metaKey || event.ctrlKey) {
          void this.plugin.sparkFrom(item);
          this.paint();
          return;
        }
        if (event.altKey) {
          this.plugin.openShuttleItem(item);
          return;
        }
        this.weave(item);
        return;
      }
      case "Backspace":
      case "Delete": {
        const item = items[this.selection];
        if (item === undefined) return;
        event.preventDefault();
        this.unload(item);
        return;
      }
      default:
    }
  }

  private move(delta: number, length: number): void {
    if (length === 0) return;
    this.selection = (this.selection + delta + length) % length;
    this.paint();
    this.scrollSelected();
  }

  private weave(item: ShuttleItem): void {
    this.plugin.weaveShuttleItem(item);
    this.paint();
  }

  private unload(item: ShuttleItem): void {
    this.plugin.shuttles.remove(item.id);
    this.selection = Math.max(0, this.selection - 1);
    this.paint();
    if (this.plugin.shuttles.items().length === 0) this.close();
  }
}
