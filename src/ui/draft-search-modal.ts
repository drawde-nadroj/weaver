import { Modal, type App } from "obsidian";

import { draftElapsed } from "../core/drafts";
import type { DraftEntry } from "../drafts/vault-index";
import type WeaverPlugin from "../main";
import { jumpToDraft } from "./draft-jump";
import { isPhone } from "./platform";

export type DraftSearchScope = "note" | "open" | "all";

const SCOPES: Array<{ key: DraftSearchScope; label: string }> = [
  { key: "note", label: "This note" },
  { key: "open", label: "Open notes" },
  { key: "all", label: "All open drafts" }
];

const SNIPPET_LENGTH = 80;

function snippet(draft: DraftEntry["draft"], query: string): string {
  const body = draft.body;
  if (query === "") return body.slice(0, SNIPPET_LENGTH);
  const position = body.toLowerCase().indexOf(query);
  if (position < 0) return body.slice(0, SNIPPET_LENGTH);

  const start = Math.max(0, position - Math.floor(SNIPPET_LENGTH / 2));
  return body.slice(start, start + SNIPPET_LENGTH);
}

/**
 * Search open drafts across the vault by id, title or body.
 *
 * A draft is usually abandoned mid-thought and remembered by a phrase, so the
 * body is searchable and the matching span is shown.
 */
export class DraftSearchModal extends Modal {
  private readonly surface = {
    input: null as HTMLInputElement | null,
    list: null as HTMLElement | null,
    status: null as HTMLElement | null
  };

  private readonly chips = new Map<DraftSearchScope, HTMLElement>();
  private entries: DraftEntry[] = [];
  private visible: DraftEntry[] = [];
  private rows: HTMLElement[] = [];
  private query = "";
  private scopeKey: DraftSearchScope = "all";
  private selected = 0;

  constructor(
    app: App,
    private readonly plugin: WeaverPlugin
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("weaver-draft-search");
    if (isPhone()) this.modalEl.addClass("weaver-modal-phone");

    this.contentEl.createEl("h2", { text: "Search drafts", cls: "weaver-sheet-title" });

    const input = this.contentEl.createEl("input", {
      cls: "weaver-draft-search-input",
      type: "search",
      placeholder: "Search open drafts"
    });
    input.setAttr("aria-label", "Search open drafts");
    input.addEventListener("input", () => {
      this.query = input.value.trim().toLowerCase();
      this.selected = 0;
      this.renderResults();
    });
    this.surface.input = input;

    const chipRow = this.contentEl.createDiv({ cls: "weaver-draft-scopes" });
    for (const scope of SCOPES) {
      const chip = chipRow.createEl("button", { cls: "weaver-draft-scope", text: scope.label });
      chip.setAttr("data-scope", scope.key);
      chip.addEventListener("click", () => {
        this.scopeKey = scope.key;
        this.selected = 0;
        this.renderResults();
      });
      this.chips.set(scope.key, chip);
    }

    this.surface.status = this.contentEl.createDiv({ cls: "weaver-draft-search-status" });
    this.surface.list = this.contentEl.createDiv({ cls: "weaver-draft-results" });

    this.modalEl.addEventListener("keydown", this.handleKeyDown);

    input.focus();
    void this.load();
  }

  onClose(): void {
    this.modalEl.removeEventListener("keydown", this.handleKeyDown);
    this.surface.input = null;
    this.surface.list = null;
    this.surface.status = null;
    this.chips.clear();
    this.rows = [];
    this.contentEl.empty();
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      this.close();
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (this.visible.length === 0) return;
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      this.selected = (this.selected + delta + this.visible.length) % this.visible.length;
      this.paintSelection();
      return;
    }

    if (event.key === "Enter") {
      const entry = this.visible[this.selected];
      if (entry === undefined) return;
      event.preventDefault();
      this.close();
      jumpToDraft(this.app, entry.file, entry.draft);
    }
  };

  private async load(): Promise<void> {
    this.entries = await this.plugin.draftIndex.openDrafts();
    this.renderResults();
  }

  private scoped(): DraftEntry[] {
    if (this.scopeKey === "all") return this.entries;

    if (this.scopeKey === "note") {
      const active = this.app.workspace.getActiveFile();
      return active === null ? [] : this.entries.filter((entry) => entry.file.path === active.path);
    }

    const open = new Set(
      this.app.workspace
        .getLeavesOfType("markdown")
        .map((leaf) => (leaf.view as { file?: { path?: string } | null }).file?.path)
        .filter((path): path is string => typeof path === "string")
    );
    return this.entries.filter((entry) => open.has(entry.file.path));
  }

  private renderResults(): void {
    const list = this.surface.list;
    if (list === null) return;

    list.empty();
    this.rows = [];

    for (const [key, chip] of this.chips) {
      chip.toggleClass("is-active", key === this.scopeKey);
    }

    const scoped = this.scoped();
    this.visible = scoped.filter((entry) => {
      if (this.query === "") return true;
      return `${entry.draft.id}\n${entry.draft.title}\n${entry.draft.body}`
        .toLowerCase()
        .includes(this.query);
    });

    if (this.visible.length === 0) {
      this.surface.status?.setText(this.query === "" ? "No open drafts." : "No drafts match.");
      return;
    }
    this.surface.status?.setText("");

    const now = new Date();
    this.visible.forEach((entry, position) => {
      const row = list.createEl("button", { cls: "weaver-draft-result" });
      row.setAttr("data-draft-id", entry.draft.id);
      if (position === this.selected) row.addClass("is-selected");

      const head = row.createDiv({ cls: "weaver-draft-result-head" });
      head.createSpan({ cls: "weaver-draft-result-id", text: `draft ${entry.draft.id}` });
      head.createSpan({
        cls: "weaver-draft-result-title",
        text: entry.draft.title.trim() === "" ? "(untitled draft)" : entry.draft.title.trim()
      });
      head.createSpan({
        cls: "weaver-draft-result-elapsed",
        text: draftElapsed(entry.draft, now)
      });

      const text = snippet(entry.draft, this.query);
      if (text !== "") row.createDiv({ cls: "weaver-draft-result-body", text });

      if (this.scopeKey !== "note") {
        row.createDiv({ cls: "weaver-draft-result-file", text: entry.file.basename });
      }

      row.addEventListener("click", () => {
        this.close();
        jumpToDraft(this.app, entry.file, entry.draft);
      });
      this.rows.push(row);
    });
  }

  private paintSelection(): void {
    this.rows.forEach((row, position) => {
      row.toggleClass("is-selected", position === this.selected);
    });
    this.rows[this.selected]?.scrollIntoView({ block: "nearest" });
  }
}
