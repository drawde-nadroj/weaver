/**
 * The settings surface: five groups, every control applied live.
 *
 * The tab owns no rules of its own — it writes the settings model and calls
 * `commit()`, so the effect of a control is always `settings.ts` plus `css.ts`.
 */

import { PluginSettingTab, Setting, type App } from "obsidian";

import type WeaverPlugin from "./main";
import { DEFAULT_SETTINGS, isValidEntrySize } from "./settings";

/** Levels beyond this stop indenting; the ceiling keeps the slider usable. */
const INDENT_LIMIT = 24;

/**
 * Settings UI, in five groups: what is written, where the day note is, how an
 * entry looks, what reads it, and the rest.
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
    this.renderWhisper(containerEl);
    this.renderAdvanced(containerEl);
  }

  private renderWriting(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "Writing" });

    new Setting(containerEl)
      .setName("Write day counters")
      .setDesc("Keep the day note's travels, depth and duration in its frontmatter.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.writeDayCounters).onChange((value) => {
          this.plugin.settings.writeDayCounters = value;
          this.commit();
        });
      });
  }

  private renderDay(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "Day" });

    new Setting(containerEl)
      .setName("Day note folder")
      .setDesc("Used only when the core Daily Notes plugin cannot be read.")
      .addText((text) => {
        text
          .setValue(this.plugin.settings.dayNoteFolder)
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
          .setValue(this.plugin.settings.dayNoteFormat)
          .setPlaceholder(DEFAULT_SETTINGS.dayNoteFormat)
          .onChange((value) => {
            this.plugin.settings.dayNoteFormat =
              value.trim() === "" ? DEFAULT_SETTINGS.dayNoteFormat : value.trim();
            this.commit();
          });
      });
  }

  private renderLook(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "Look" });

    new Setting(containerEl)
      .setName("Equalize entry sizes")
      .setDesc("Render every entry at one size, whatever its depth.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.equalizeEntrySizes).onChange((value) => {
          this.plugin.settings.equalizeEntrySizes = value;
          this.commit();
        });
      });

    new Setting(containerEl)
      .setName("Entry size")
      .setDesc("CSS length, for example 1em or 18px.")
      .addText((text) => {
        text
          .setValue(this.plugin.settings.entrySize)
          .setPlaceholder(DEFAULT_SETTINGS.entrySize)
          .onChange((value) => {
            // Ignore intermediate or invalid input instead of writing bad CSS.
            if (!isValidEntrySize(value)) return;
            this.plugin.settings.entrySize = value.trim();
            this.commit();
          });
      });

    new Setting(containerEl)
      .setName("Indent step (desktop)")
      .setDesc("Pixels added per dimension level.")
      .addSlider((slider) => {
        slider
          .setLimits(0, 48, 1)
          .setValue(this.plugin.settings.indentStep)
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
          .setValue(this.plugin.settings.mobileIndentStep)
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
          .setLimits(1, INDENT_LIMIT, 1)
          .setValue(this.plugin.settings.indentMaxLevel)
          .setDynamicTooltip()
          .onChange((value) => {
            this.plugin.settings.indentMaxLevel = Math.round(value);
            this.commit();
          });
      });

    new Setting(containerEl)
      .setName("Port em/strong colours")
      .setDesc("Orange emphasis, red strong emphasis.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.portEmphasisColors).onChange((value) => {
          this.plugin.settings.portEmphasisColors = value;
          this.commit();
        });
      });

    new Setting(containerEl)
      .setName("Frame each entry")
      .setDesc("Draw a rounded frame around every entry: the marker row is its top rail label, and its clock row labels the bottom edge with the moment at the left and the duration at the right.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.entryFrames).onChange((value) => {
          this.plugin.settings.entryFrames = value;
          this.commit();
        });
      });

    new Setting(containerEl)
      .setName("Frame follows the indent")
      .setDesc("On, a nested entry's frame starts further right, so nesting reads as a staircase. Off, every frame starts in the left margin and only the prose is indented, so the markers and the times line up down the note.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.frameFollowsIndent).onChange((value) => {
          this.plugin.settings.frameFollowsIndent = value;
          this.commit();
        });
      });
  }

  private renderWhisper(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "Whisper" });

    new Setting(containerEl)
      .setName("Whisper settled entries")
      .setDesc("Write one to three `~` rows above a settled entry: the model's reading of what it holds.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.whisperEnabled).onChange((value) => {
          this.plugin.settings.whisperEnabled = value;
          this.commit();
        });
      });

    new Setting(containerEl)
      .setName("Place each entry in its day")
      .setDesc(
        "Ask a second question per entry: which earlier entry it repeats or picks up. It costs one request per entry, and a small model answers it thinly — about one usable placement per day's twenty entries."
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.whisperThreads).onChange((value) => {
          this.plugin.settings.whisperThreads = value;
          this.commit();
        });
      });

    new Setting(containerEl)
      .setName("Endpoint")
      .setDesc(
        "An address this device can reach. 127.0.0.1 is this machine only; the machine's own reachable name makes whispers work on a phone too."
      )
      .addText((text) => {
        text
          .setValue(this.plugin.settings.whisperEndpoint)
          .setPlaceholder(DEFAULT_SETTINGS.whisperEndpoint)
          .onChange((value) => {
            this.plugin.settings.whisperEndpoint = value.trim();
            this.commit();
          });
      });

    new Setting(containerEl)
      .setName("Model")
      .setDesc(
        "The model's name at that endpoint. A thinking model spends the whole answer budget on its reasoning and returns no text, so turn thinking off in that model's own settings, or use a non-thinking model."
      )
      .addText((text) => {
        text
          .setValue(this.plugin.settings.whisperModelId)
          .setPlaceholder(DEFAULT_SETTINGS.whisperModelId)
          .onChange((value) => {
            this.plugin.settings.whisperModelId = value.trim();
            this.commit();
          });
      });

    new Setting(containerEl)
      .setName("API key")
      .setDesc(
        "Kept in this plugin's data.json in plain text, and it syncs with the vault. Leave it empty for a local endpoint."
      )
      .addText((text) => {
        text
          .setValue(this.plugin.settings.whisperApiKey)
          .onChange((value) => {
            this.plugin.settings.whisperApiKey = value.trim();
            this.commit();
          });
      });
  }

  private renderAdvanced(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "Advanced" });

    new Setting(containerEl)
      .setName("Debug logging")
      .setDesc("Verbose console output.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.debug).onChange((value) => {
          this.plugin.settings.debug = value;
          this.commit();
        });
      });
  }
}
