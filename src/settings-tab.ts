import { PluginSettingTab, Setting, type App } from "obsidian";

import type WeaverPlugin from "./main";
import {
  DEFAULT_SETTINGS,
  MAX_MAX_DEPTH,
  MIN_MAX_DEPTH,
  isValidHeadingSize,
  type WeaverSettings
} from "./settings";
import { dimensionLabel } from "./core/vocabulary";

function paletteSpan(settings: WeaverSettings, vaultMaxLevel: number): number {
  return Math.min(Math.max(Math.max(6, vaultMaxLevel), 6), settings.maxDepth);
}

/**
 * Settings UI, in four groups: what a dimension looks like when written, where
 * a spark lands, how the note is drawn, and the rest.
 *
 * Every control writes through `commit()` so changes apply live.
 */
export class WeaverSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: WeaverPlugin
  ) {
    super(app, plugin);
  }

  /** Applies immediately, then persists; the UI never waits on disk. */
  private commit(): void {
    this.plugin.onSettingsChange();
    void this.plugin.saveSettings();
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("weaver-settings");

    containerEl.createEl("h2", { text: "Weaver" });

    this.renderWriting(containerEl);
    this.renderDay(containerEl);
    this.renderLook(containerEl);
    this.renderAdvanced(containerEl);
  }

  /** The note's own convention: how a dimension is written. */
  private renderWriting(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "Writing" });
    const settings = this.plugin.settings;

    new Setting(containerEl)
      .setName("Timestamp format")
      .setDesc("Clock precision for new dimensions.")
      .addDropdown((dropdown) => {
        dropdown
          .addOptions({ "HH:mm:ss": "HH:mm:ss", "HH:mm": "HH:mm" })
          .setValue(settings.timestampFormat)
          .onChange((value) => {
            this.plugin.settings.timestampFormat = value === "HH:mm" ? "HH:mm" : "HH:mm:ss";
            this.commit();
          });
      });

    new Setting(containerEl)
      .setName("Separator")
      .setDesc("Text placed between the time and the title.")
      .addText((text) => {
        text
          .setValue(settings.timestampSeparator)
          .setPlaceholder(DEFAULT_SETTINGS.timestampSeparator)
          .onChange((value) => {
            this.plugin.settings.timestampSeparator = value;
            this.commit();
          });
      });

    new Setting(containerEl)
      .setName("Maximum dimension depth")
      .setDesc("Highest level that is parsed, coloured, and inserted.")
      .addSlider((slider) => {
        slider
          .setLimits(MIN_MAX_DEPTH, MAX_MAX_DEPTH, 1)
          .setValue(settings.maxDepth)
          .setDynamicTooltip()
          .onChange((value) => {
            const next = Math.round(value);
            if (next === this.plugin.settings.maxDepth) return;
            this.plugin.settings.maxDepth = next;
            this.plugin.settings.indentMaxLevel = Math.min(this.plugin.settings.indentMaxLevel, next);
            const travel = this.plugin.settings.travelDefaultLevel;
            if (travel !== "all" && travel > next) this.plugin.settings.travelDefaultLevel = "all";
            this.commit();
            // Level-dependent controls must be rebuilt for the new cap.
            this.display();
          });
      });
  }

  private renderDay(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "Day" });
    const settings = this.plugin.settings;

    new Setting(containerEl)
      .setName("Spark target")
      .setDesc("Where a spark lands: today's day note, or the note being edited.")
      .addDropdown((dropdown) => {
        dropdown
          .addOptions({ today: "Today", note: "This note" })
          .setValue(settings.sparkTarget)
          .onChange((value) => {
            this.plugin.settings.sparkTarget = value === "note" ? "note" : "today";
            this.commit();
          });
      });

    new Setting(containerEl)
      .setName("Write day counters")
      .setDesc("Keep the day note's sparks, dimensions and sources counts in its frontmatter.")
      .addToggle((toggle) => {
        toggle.setValue(settings.writeDayCounters).onChange((value) => {
          this.plugin.settings.writeDayCounters = value;
          this.commit();
        });
      });

    new Setting(containerEl)
      .setName("Day note folder")
      .setDesc("Used only when the core Daily Notes plugin cannot be read.")
      .addText((text) => {
        text
          .setValue(settings.dayNoteFolder)
          .setPlaceholder(DEFAULT_SETTINGS.dayNoteFolder)
          .onChange((value) => {
            this.plugin.settings.dayNoteFolder = value.trim();
            this.commit();
          });
      });

    new Setting(containerEl)
      .setName("Day note format")
      .setDesc("Used only when the core Daily Notes plugin cannot be read.")
      .addText((text) => {
        text
          .setValue(settings.dayNoteFormat)
          .setPlaceholder(DEFAULT_SETTINGS.dayNoteFormat)
          .onChange((value) => {
            this.plugin.settings.dayNoteFormat =
              value.trim() === "" ? DEFAULT_SETTINGS.dayNoteFormat : value.trim();
            this.commit();
          });
      });
  }

  /** How the note is drawn: sizes, indent, colour and drafts. */
  private renderLook(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "Look" });
    const settings = this.plugin.settings;

    new Setting(containerEl)
      .setName("Equalize dimension sizes")
      .setDesc(
        "Render every dimension at the default size. Turn this off to use the per-level sizes below."
      )
      .addToggle((toggle) => {
        toggle.setValue(settings.equalizeHeadingSizes).onChange((value) => {
          this.plugin.settings.equalizeHeadingSizes = value;
          this.commit();
          // The level size fields are only editable when sizes are not equalized.
          this.display();
        });
      });

    new Setting(containerEl)
      .setName("Dimension size")
      .setDesc("CSS length used when sizes are equalized, for example 1em or 18px.")
      .addText((text) => {
        text
          .setValue(settings.headingSize)
          .setPlaceholder(DEFAULT_SETTINGS.headingSize)
          .onChange((value) => {
            // Ignore intermediate or invalid input instead of writing bad CSS.
            if (!isValidHeadingSize(value)) return;
            this.plugin.settings.headingSize = value.trim();
            this.commit();
          });
      });

    this.renderLevelSizes(containerEl);

    new Setting(containerEl)
      .setName("Dimension weight")
      .addSlider((slider) => {
        slider
          .setLimits(300, 800, 50)
          .setValue(settings.headingWeight)
          .setDynamicTooltip()
          .onChange((value) => {
            this.plugin.settings.headingWeight = Math.round(value);
            this.commit();
          });
      });

    new Setting(containerEl)
      .setName("Indent step (desktop)")
      .setDesc("Pixels added per dimension level.")
      .addSlider((slider) => {
        slider
          .setLimits(0, 48, 1)
          .setValue(settings.indentStep)
          .setDynamicTooltip()
          .onChange((value) => {
            this.plugin.settings.indentStep = Math.round(value);
            this.commit();
          });
      });

    new Setting(containerEl)
      .setName("Indent step (mobile)")
      .addSlider((slider) => {
        slider
          .setLimits(0, 32, 1)
          .setValue(settings.mobileIndentStep)
          .setDynamicTooltip()
          .onChange((value) => {
            this.plugin.settings.mobileIndentStep = Math.round(value);
            this.commit();
          });
      });

    new Setting(containerEl)
      .setName("Indent maximum level")
      .setDesc("Levels beyond this stop indenting further.")
      .addSlider((slider) => {
        slider
          .setLimits(1, settings.maxDepth, 1)
          .setValue(settings.indentMaxLevel)
          .setDynamicTooltip()
          .onChange((value) => {
            this.plugin.settings.indentMaxLevel = Math.round(value);
            this.commit();
          });
      });

    new Setting(containerEl)
      .setName("Colour mode")
      .setDesc(
        "Vault stretch spreads the six anchors across the deepest dimension in the vault. Fixed rainbow keeps 1D–6D exact and extends past them."
      )
      .addDropdown((dropdown) => {
        dropdown
          .addOptions({
            "vault-stretch": "Vault stretch",
            "fixed-anchor": "Fixed rainbow + extension"
          })
          .setValue(settings.colorMode)
          .onChange((value) => {
            this.plugin.settings.colorMode = value === "fixed-anchor" ? "fixed-anchor" : "vault-stretch";
            this.commit();
            this.display();
          });
      });

    const swatches = new Setting(containerEl).setName("Current palette");
    this.renderSwatches(swatches.controlEl);
    swatches.addExtraButton((button) => {
      button.setIcon("refresh-cw").setTooltip("Recalculate palette").onClick(async () => {
        await this.plugin.rescanPalette();
        this.display();
      });
    });

    new Setting(containerEl)
      .setName("Transition")
      .setDesc("Colour transition when the palette changes, in milliseconds.")
      .addSlider((slider) => {
        slider
          .setLimits(0, 1000, 50)
          .setValue(settings.paletteTransitionMs)
          .setDynamicTooltip()
          .onChange((value) => {
            this.plugin.settings.paletteTransitionMs = Math.round(value);
            this.commit();
          });
      });

    new Setting(containerEl)
      .setName("Deep dimensions in Live Preview")
      .setDesc("Render 7D and deeper as dimensions, hiding the hash run when the cursor is elsewhere.")
      .addToggle((toggle) => {
        toggle.setValue(settings.deepHeadingLivePreview).onChange((value) => {
          this.plugin.settings.deepHeadingLivePreview = value;
          this.commit();
        });
      });

    new Setting(containerEl)
      .setName("Deep dimensions in Reading view")
      .setDesc("Transform 7D and deeper paragraphs into dimensions.")
      .addToggle((toggle) => {
        toggle.setValue(settings.deepHeadingReadingView).onChange((value) => {
          this.plugin.settings.deepHeadingReadingView = value;
          this.commit();
        });
      });

    new Setting(containerEl)
      .setName("Port em/strong colours")
      .setDesc("Orange emphasis, red strong emphasis.")
      .addToggle((toggle) => {
        toggle.setValue(settings.portEmphasisColors).onChange((value) => {
          this.plugin.settings.portEmphasisColors = value;
          this.commit();
        });
      });

    new Setting(containerEl)
      .setName("Render drafts in the note")
      .setDesc(
        "Show draft markers as a card with its opened time and elapsed timer. Turn this off to keep the markers as plain text; drafts stay weavable either way."
      )
      .addToggle((toggle) => {
        toggle.setValue(settings.inPageDrafts).onChange((value) => {
          this.plugin.settings.inPageDrafts = value;
          this.commit();
        });
      });
  }

  /** One size field per level, used when sizes are not equalized. */
  private renderLevelSizes(containerEl: HTMLElement): void {
    const settings = this.plugin.settings;
    const wrapper = containerEl.createDiv({ cls: "weaver-level-sizes" });
    wrapper.createDiv({ cls: "weaver-level-sizes-title", text: "Level sizes" });
    wrapper.createDiv({
      cls: "weaver-level-sizes-hint",
      text: settings.equalizeHeadingSizes
        ? "Dimension sizes are equalized; turn that off to set a size per level. Leave a field blank to keep the theme size."
        : "Leave a field blank to keep the theme size. Accepts em, rem or px."
    });

    const grid = wrapper.createDiv({ cls: "weaver-level-sizes-grid" });

    for (let level = 1; level <= settings.maxDepth; level += 1) {
      const row = grid.createDiv({ cls: "weaver-level-size-row" });
      row.createSpan({ cls: "weaver-level-size-label", text: dimensionLabel(level) });

      const input = row.createEl("input", {
        cls: "weaver-level-size-input",
        type: "text",
        placeholder: "theme",
        value: settings.headingLevelSizes[level] ?? ""
      });
      input.setAttr("aria-label", `${dimensionLabel(level)} size`);
      input.disabled = settings.equalizeHeadingSizes;
      input.addEventListener("change", () => this.commitLevelSize(level, input));
    }

    new Setting(containerEl)
      .setName("Reset level sizes")
      .setDesc("Clear every per-level size so dimensions use the theme scale.")
      .addButton((button) => {
        button.setButtonText("Reset").onClick(() => {
          this.plugin.settings.headingLevelSizes = {};
          this.commit();
          this.display();
        });
      });
  }

  private commitLevelSize(level: number, input: HTMLInputElement): void {
    const value = input.value.trim();

    if (value === "") {
      delete this.plugin.settings.headingLevelSizes[level];
      this.commit();
      return;
    }

    if (!isValidHeadingSize(value)) {
      // Reject invalid input and restore the last good value.
      input.value = this.plugin.settings.headingLevelSizes[level] ?? "";
      return;
    }

    this.plugin.settings.headingLevelSizes[level] = value;
    this.commit();
  }

  private renderSwatches(containerEl: HTMLElement): void {
    const row = containerEl.createDiv({ cls: "weaver-swatches" });
    this.plugin.palette.forEach((color, index) => {
      const swatch = row.createDiv({ cls: "weaver-swatch", text: dimensionLabel(index + 1) });
      swatch.style.backgroundColor = color;
      swatch.setAttr("title", `${dimensionLabel(index + 1)} ${color}`);
    });
  }

  /** Rescanning, travel and logging: the controls that are not about writing. */
  private renderAdvanced(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "Advanced" });
    const settings = this.plugin.settings;
    const vaultMax = this.plugin.data.lastVaultMaxLevel;

    new Setting(containerEl)
      .setName("Vault depth")
      .setDesc(
        vaultMax === 0
          ? "No dimensions found yet; the palette spans 1D–6D."
          : `Deepest dimension is ${dimensionLabel(vaultMax)}; the palette spans 1D–${dimensionLabel(paletteSpan(settings, vaultMax))}.`
      )
      .addButton((button) => {
        button.setButtonText("Rescan").onClick(async () => {
          await this.plugin.rescanPalette();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName("Travel default level")
      .setDesc("Level filter travel starts with.")
      .addDropdown((dropdown) => {
        dropdown.addOption("all", "All");
        for (let level = 1; level <= settings.maxDepth; level += 1) {
          dropdown.addOption(String(level), dimensionLabel(level));
        }
        dropdown.setValue(String(settings.travelDefaultLevel)).onChange((value) => {
          this.plugin.settings.travelDefaultLevel = value === "all" ? "all" : Number(value);
          this.commit();
        });
      });

    new Setting(containerEl)
      .setName("Travel wraps around")
      .setDesc("Whether travel wraps at the first and last dimension.")
      .addToggle((toggle) => {
        toggle.setValue(settings.travelWrap).onChange((value) => {
          this.plugin.settings.travelWrap = value;
          this.commit();
        });
      });

    new Setting(containerEl)
      .setName("Debug logging")
      .setDesc("Verbose console output.")
      .addToggle((toggle) => {
        toggle.setValue(settings.debug).onChange((value) => {
          this.plugin.settings.debug = value;
          this.commit();
        });
      });
  }
}
