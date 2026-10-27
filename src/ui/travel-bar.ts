import type { LevelFilter, TravelKind } from "../core/travel";
import { dimensionLabel } from "../core/vocabulary";

export interface TravelSurfaceState {
  kind: TravelKind;
  level: LevelFilter;
  maxDepth: number;
  /** Current target's text, or a placeholder when the filter is empty. */
  label: string;
  canParent: boolean;
  canChild: boolean;
  /** Drafts mode: 1-based position among the filtered drafts, 0 when empty. */
  position: number;
  total: number;
  /** Drafts mode: the target draft's own level, regardless of the filter. */
  targetLevel: number | null;
}

export interface TravelActions {
  setLevel(level: LevelFilter): void;
  move(direction: "next" | "prev"): void;
  parent(): void;
  child(): void;
  goFirst(): void;
  goLast(): void;
  /** `Tab`: switch between dimensions and drafts. */
  toggleKind(): void;
  exit(): void;
}

function levelLabel(level: LevelFilter): string {
  return level === "all" ? "All" : dimensionLabel(level);
}

const KEYS_HINT = "1-9 level · ↑↓ move · ←→ parent/child · Tab drafts · g/G first/last · ⏎ exit";

/** Desktop and tablet pill describing the current travel state. */
export class TravelHud {
  private readonly root: HTMLElement;
  private readonly stateEl: HTMLElement;

  constructor() {
    this.root = document.body.createDiv({ cls: "weaver-travel-hud" });
    this.root.createSpan({ cls: "weaver-hud-kicker", text: "TRAVEL" });
    this.stateEl = this.root.createSpan({ cls: "weaver-hud-state" });
    this.root.createSpan({ cls: "weaver-hud-keys", text: KEYS_HINT });
  }

  render(state: TravelSurfaceState): void {
    if (state.kind === "drafts") {
      const parts = ["DRAFT"];
      parts.push(state.targetLevel === null ? levelLabel(state.level) : dimensionLabel(state.targetLevel));
      if (state.label.length > 0) parts.push(state.label);
      if (state.total > 0) parts.push(`${state.position}/${state.total}`);
      this.stateEl.setText(parts.join(" · "));
      return;
    }

    const suffix = state.label.length > 0 ? ` · ${state.label}` : "";
    this.stateEl.setText(`${levelLabel(state.level)}${suffix}`);
  }

  destroy(): void {
    this.root.remove();
  }
}

/** Phone bottom bar: kind toggle, chips, movement buttons, target, Done. */
export class TravelBar {
  private readonly root: HTMLElement;
  private readonly chips = new Map<string, HTMLElement>();
  private readonly labelEl: HTMLElement;
  private readonly kindButton: HTMLButtonElement;
  private readonly parentButton: HTMLButtonElement;
  private readonly childButton: HTMLButtonElement;

  constructor(
    private readonly actions: TravelActions,
    maxDepth: number
  ) {
    this.root = document.body.createDiv({ cls: "weaver-travel-bar" });

    this.kindButton = this.root.createEl("button", {
      cls: "weaver-travel-kind",
      text: "Dimensions"
    });
    this.kindButton.setAttr("aria-label", "Switch between dimensions and drafts");
    this.kindButton.addEventListener("click", () => this.actions.toggleKind());

    const levels = this.root.createDiv({ cls: "weaver-travel-levels" });
    this.addChip(levels, "all", "All");
    for (let level = 1; level <= maxDepth; level += 1) {
      this.addChip(levels, String(level), String(level));
    }

    this.labelEl = this.root.createDiv({ cls: "weaver-travel-label" });

    const controls = this.root.createDiv({ cls: "weaver-travel-controls" });
    this.parentButton = this.addButton(controls, "←", "Parent dimension", () => this.actions.parent());
    this.addButton(controls, "↑", "Previous target", () => this.actions.move("prev"));
    this.addButton(controls, "↓", "Next target", () => this.actions.move("next"));
    this.childButton = this.addButton(controls, "→", "First child dimension", () => this.actions.child());
    const done = this.addButton(controls, "Done", "Exit travel", () => this.actions.exit());
    done.addClass("mod-cta");
  }

  private addChip(container: HTMLElement, key: string, label: string): HTMLElement {
    const chip = container.createEl("button", { cls: "weaver-travel-chip", text: label });
    chip.setAttr("aria-label", key === "all" ? "All levels" : `Dimension level ${key}`);
    chip.addEventListener("click", () => {
      this.actions.setLevel(key === "all" ? "all" : Number(key));
    });
    this.chips.set(key, chip);
    return chip;
  }

  private addButton(
    container: HTMLElement,
    label: string,
    ariaLabel: string,
    action: () => void
  ): HTMLButtonElement {
    const button = container.createEl("button", { cls: "weaver-travel-button", text: label });
    button.setAttr("aria-label", ariaLabel);
    button.addEventListener("click", action);
    return button;
  }

  render(state: TravelSurfaceState): void {
    const drafts = state.kind === "drafts";
    this.kindButton.setText(drafts ? "Drafts" : "Dimensions");
    this.kindButton.toggleClass("is-drafts", drafts);

    const active = state.level === "all" ? "all" : String(state.level);
    for (const [key, chip] of this.chips) {
      chip.toggleClass("is-active", key === active);
    }

    const empty = drafts ? "No draft at this level" : "No dimension at this level";
    this.labelEl.setText(state.label.length > 0 ? state.label : empty);
    this.parentButton.disabled = !state.canParent;
    this.childButton.disabled = !state.canChild;
  }

  destroy(): void {
    this.root.remove();
  }
}
