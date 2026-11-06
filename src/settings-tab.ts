/**
 * The settings surface: six groups, every control applied live.
 *
 * The tab owns no rules of its own — it writes the settings model and calls
 * `commit()`, so the effect of a control is always `settings.ts` plus `css.ts`.
 *
 * Realms are the one group that edits a list, so it is the one group that
 * has to be careful with stored data: a row it does not understand is shown with
 * its reason and left in place, and nothing is rewritten into a shape the writer
 * did not ask for.
 */

import { PluginSettingTab, Setting, type App } from "obsidian";

import {
  contextDraftError,
  freshContextId,
  readContexts,
  type ContextError
} from "./core/contexts";
import { dayNoteOptions } from "./entries/day-note";
import { readPortalSchedules } from "./core/portals";
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
  /** The Realm being written in the inline form, or null when there is none. */
  private draftRealm: { name: string; folder: string; format: string; error: string | null } | null = null;
  /** The Realm whose removal was asked for once, and needs a second press. */
  private armedRealm: number | null = null;

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
    this.renderRealms(containerEl);
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
    new Setting(containerEl)
      .setName("Invitations")
      .setDesc(
        "Offer scheduled calls to action. An invitation opens the same composer every other gesture opens, and writing there never needs its note on screen. Turning this off hides every invitation and keeps every entry, Thread and recorded history."
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.portalsEnabled).onChange((value) => {
          this.plugin.settings.portalsEnabled = value;
          this.commit();
        });
      });

    new Setting(containerEl)
      .setName("Offer the built-in rhythm")
      .setDesc(
        "The local minutes :00, :11, :22, :33, :44 and :55, and each mirrored HH:HH, with eleven minutes of notice. It invites writing into Main."
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.rhythmicPortalsEnabled).onChange((value) => {
          this.plugin.settings.rhythmicPortalsEnabled = value;
          this.commit();
        });
      });

    new Setting(containerEl)
      .setName("Invitation motion")
      .setDesc(
        "How much the invitation's rainbow moves. Off keeps a still rainbow; nothing else about the surface changes, and no second animation runs beside it."
      )
      .addDropdown((dropdown) => {
        dropdown
          .addOptions({ off: "Off", slow: "Slow", normal: "Normal", fast: "Fast" })
          .setValue(this.plugin.settings.portalMotion)
          .onChange((value) => {
            this.plugin.settings.portalMotion =
              value === "off" || value === "slow" || value === "normal" || value === "fast"
                ? value
                : "normal";
            this.commit();
          });
      });

    this.renderSchedules(containerEl);
  }

  /**
   * The stored schedule rows, or null when the value is not a list.
   *
   * Same discipline as destinations: a row this build cannot read is reported and
   * left where it is, and an edit patches exactly the row it names.
   */
  private scheduleRows(): unknown[] | null {
    const raw = this.plugin.settings.portalSchedules;
    return Array.isArray(raw) ? [...raw] : null;
  }

  /** A weekday tick list, as the array a weekly schedule stores. */
  private writeScheduleDays(index: number, day: number, on: boolean): void {
    const rows = this.scheduleRows();
    if (rows === null) return;
    const row = rows[index];
    if (typeof row !== "object" || row === null) return;

    const when = (row as Record<string, unknown>)["when"];
    const weekly =
      typeof when === "object" && when !== null && (when as Record<string, unknown>)["kind"] === "weekly"
        ? (when as Record<string, unknown>)
        : { kind: "weekly", weekdays: [], hour: 9, minute: 0 };

    const current = Array.isArray(weekly["weekdays"]) ? weekly["weekdays"] : [];
    const weekdays = current.filter((value): value is number => typeof value === "number");
    const next = on
      ? [...new Set([...weekdays, day])].sort((a, b) => a - b)
      : weekdays.filter((value) => value !== day);

    rows[index] = { ...(row as Record<string, unknown>), when: { ...weekly, weekdays: next } };
    this.plugin.settings.portalSchedules = rows;
    this.commit();
  }

  private renderSchedules(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "Schedules" });

    const read = readPortalSchedules(this.plugin.settings.portalSchedules);
    const readable = this.scheduleRows() !== null;

    if (!readable) {
      new Setting(containerEl)
        .setName("Stored schedules are unreadable")
        .setDesc(read.errors[0]?.message ?? "The stored value is not a list of schedules.")
        .addButton((button) => {
          button
            .setButtonText("Reset schedules")
            .setCta()
            .onClick(() => {
              this.plugin.settings.portalSchedules = [];
              this.commit();
              this.display();
            });
        });
      return;
    }

    for (const schedule of read.valid) {
      const row = this.scheduleRows()?.findIndex(
        (candidate) =>
          typeof candidate === "object" && candidate !== null &&
          (candidate as Record<string, unknown>)["id"] === schedule.id
      );
      if (row === undefined || row < 0) continue;

      const when = schedule.when;
      const description =
        when.kind === "hourly"
          ? `Every hour at :${String(when.minute).padStart(2, "0")}.`
          : when.kind === "weekly"
            ? `${when.weekdays.length === 7 ? "Every day" : "Days " + when.weekdays.join(", ")} at ${String(when.hour).padStart(2, "0")}:${String(when.minute).padStart(2, "0")}.`
            : `Once, at ${new Date(when.at).toLocaleString()}.`;

      const setting = new Setting(containerEl)
        .setName(schedule.name)
        .setDesc(description)
        .addToggle((toggle) => {
          toggle.setValue(schedule.enabled).onChange((value) => {
            const rows = this.scheduleRows();
            if (rows === null) return;
            const current = rows[row];
            if (typeof current !== "object" || current === null) return;
            rows[row] = { ...(current as Record<string, unknown>), enabled: value };
            this.plugin.settings.portalSchedules = rows;
            this.commit();
          });
        })
        .addExtraButton((button) => {
          button
            .setIcon("trash")
            .setTooltip("Remove this schedule, keeping its entries")
            .onClick(() => {
              const rows = this.scheduleRows();
              if (rows === null) return;
              rows.splice(row, 1);
              this.plugin.settings.portalSchedules = rows;
              this.commit();
              this.display();
            });
        });

      if (when.kind === "weekly") {
        for (let day = 0; day < 7; day += 1) {
          setting.addToggle((toggle) => {
            toggle.setValue(when.weekdays.includes(day)).onChange((value) => {
              this.writeScheduleDays(row, day, value);
            });
          });
        }
      }
    }

    for (const error of read.errors) {
      if (error.index === null) continue;
      new Setting(containerEl)
        .setName(`Schedule ${error.index + 1}`)
        .setDesc(error.message);
    }

    new Setting(containerEl)
      .setName("Add schedule")
      .setDesc(
        "A weekly invitation, as a starting point: every day at 09:00, with eleven minutes of notice. Edit the row to change its days, time or destination."
      )
      .addButton((button) => {
        button
          .setButtonText("Add schedule")
          .setCta()
          .onClick(() => {
            const rows = this.scheduleRows();
            if (rows === null) return;
            rows.push({
              id: `schedule-${Date.now().toString(36)}`,
              name: "Morning",
              contextId: "main",
              enabled: true,
              createdAt: Date.now(),
              leadMinutes: 11,
              when: { kind: "weekly", weekdays: [0, 1, 2, 3, 4, 5, 6], hour: 9, minute: 0 }
            });
            this.plugin.settings.portalSchedules = rows;
            this.commit();
            this.display();
          });
      });
  }

  /**
   * The stored destination rows, or null when the value is not a list.
   *
   * Edits patch exactly the row they name: a row this build cannot read is data
   * the writer put there, so an edit elsewhere must not drop it.
   */
  private contextRows(): unknown[] | null {
    const raw = this.plugin.settings.contexts;
    return Array.isArray(raw) ? [...raw] : null;
  }

  private writeContextRow(index: number, patch: Record<string, unknown>): void {
    const rows = this.contextRows();
    if (rows === null) return;

    const current = rows[index];
    rows[index] =
      typeof current === "object" && current !== null && !Array.isArray(current)
        ? { ...(current as Record<string, unknown>), ...patch }
        : { ...patch };
    this.plugin.settings.contexts = rows;
    this.commit();
  }

  private removeContextRow(index: number): void {
    const rows = this.contextRows();
    if (rows === null) return;
    rows.splice(index, 1);
    this.plugin.settings.contexts = rows;
    this.commit();
    this.display();
  }

  /**
   * Opens the inline form a new Realm is written in.
   *
   * Nothing is stored until the form is accepted: an unfinished idea is not a
   * Realm, and a half-typed folder must not become one. The filename format is
   * prefilled so the first thing on screen is a working definition.
   */
  private beginAddRealm(): void {
    this.draftRealm = {
      name: "",
      folder: "",
      format: DEFAULT_SETTINGS.dayNoteFormat,
      error: null
    };
    this.display();
  }

  /**
   * Creates the Realm the inline form describes, or says what is missing.
   *
   * A stored value that is not a list cannot be appended to: that needs an
   * explicit reset, so an unreadable payload is never overwritten by Add.
   */
  private commitAddRealm(): void {
    const draft = this.draftRealm;
    if (draft === null) return;

    const name = draft.name.trim();
    const folder = draft.folder.trim();
    const format = draft.format.trim();

    const problem =
      name === ""
        ? "A Realm needs a name."
        : folder === ""
          ? "A Realm needs a folder for its daily notes."
          : contextDraftError(folder, format);
    if (problem !== null) {
      this.draftRealm = { ...draft, error: problem };
      this.display();
      return;
    }

    const rows = this.contextRows();
    if (rows === null) return;

    rows.push({ id: freshContextId(), name, folder, format });
    this.plugin.settings.contexts = rows;
    this.draftRealm = null;
    this.commit();
    this.display();
  }

  private renderRealms(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "Realms" });

    const options = dayNoteOptions(this.app, this.plugin.settings);
    const read = readContexts(this.plugin.settings.contexts, options);

    new Setting(containerEl)
      .setName("Main")
      .setDesc(
        `This vault's own day notes: ${options.folder === "" ? "the vault root" : options.folder}, ${options.format}. It follows the core Daily Notes settings when they can be read, and the two fallbacks below when they cannot.`
      );

    const listIsReadable = this.contextRows() !== null;

    if (!listIsReadable) {
      new Setting(containerEl)
        .setName("Stored Realms are unreadable")
        .setDesc(
          read.errors[0]?.message ??
            "The stored value is not a list of Realms. Nothing will be written to it until it is reset."
        )
        .addButton((button) => {
          button
            .setButtonText("Reset Realms")
            .setCta()
            .onClick(() => {
              this.plugin.settings.contexts = [];
              this.commit();
              this.display();
            });
        });
    }

    for (const row of read.rows) {
      this.renderContextRow(containerEl, row.index, row.context.name, row.context.folder, row.context.format, null);
    }

    for (const error of read.errors) {
      if (error.index === null) continue;
      // The row keeps whatever the writer stored, so its fields show the values
      // that were rejected rather than a blank form that would look like new.
      const raw = this.contextRows()?.[error.index];
      const row = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
      const field = (key: string): string => (typeof row[key] === "string" ? (row[key] as string) : "");
      this.renderContextRow(containerEl, error.index, field("name"), field("folder"), field("format"), error);
    }

    if (listIsReadable) {
      if (this.draftRealm === null) {
        new Setting(containerEl)
          .setName("Add Realm")
          .setDesc(
            "Another folder to weave into, beside Main, with its own writing history and remembered workspace. Writing there never needs that note open, and ordinary documents may live in the same folder."
          )
          .addButton((button) => {
            button
              .setButtonText("Add Realm")
              .setCta()
              .onClick(() => this.beginAddRealm());
          });
      } else {
        this.renderDraftRealm(containerEl);
      }
    }
  }

  /**
   * The inline form for a Realm that does not exist yet.
   *
   * It writes nothing to settings: `Create Realm` is the only thing that commits,
   * and `Cancel` leaves the stored list exactly as it was.
   */
  private renderDraftRealm(containerEl: HTMLElement): void {
    const draft = this.draftRealm;
    if (draft === null) return;

    // Read the live draft, not the one this render closed over: two fields edited
    // in one pass must not overwrite each other.
    const edit = (patch: Partial<{ name: string; folder: string; format: string }>): void => {
      const current = this.draftRealm;
      if (current === null) return;
      this.draftRealm = { ...current, ...patch, error: null };
    };

    new Setting(containerEl)
      .setName("New Realm")
      .setDesc(draft.error ?? "A name, the folder its daily notes live in, and how they are named.")
      .addText((text) => {
        text
          .setPlaceholder("Name")
          .setValue(draft.name)
          .onChange((value) => edit({ name: value }));
      })
      .addText((text) => {
        text
          .setPlaceholder("Daily notes folder")
          .setValue(draft.folder)
          .onChange((value) => edit({ folder: value }));
      })
      .addText((text) => {
        text
          .setPlaceholder("Filename format")
          .setValue(draft.format)
          .onChange((value) => edit({ format: value }));
      })
      .addButton((button) => {
        button
          .setButtonText("Create Realm")
          .setCta()
          .onClick(() => this.commitAddRealm());
      })
      .addButton((button) => {
        button.setButtonText("Cancel").onClick(() => {
          this.draftRealm = null;
          this.display();
        });
      });
  }

  /** One Realm: its three fields, its own error, and its removal. */
  private renderContextRow(
    containerEl: HTMLElement,
    index: number,
    name: string,
    folder: string,
    format: string,
    error: ContextError | null
  ): void {
    const draft = contextDraftError(folder, format);

    new Setting(containerEl)
      .setName(name === "" ? `Realm ${index + 1}` : name)
      .setDesc(
        error !== null
          ? error.message
          : draft !== null
            ? draft
            : `Daily notes in ${folder === "" ? "the vault root" : folder}, named ${format}.`
      )
      .addText((text) => {
        text.setPlaceholder("Name").setValue(name).onChange((value) => {
          this.writeContextRow(index, { name: value.trim() });
        });
      })
      .addText((text) => {
        text
          .setPlaceholder("Daily notes folder")
          .setValue(folder)
          .onChange((value) => {
            this.writeContextRow(index, { folder: value });
          });
      })
      .addText((text) => {
        text
          .setPlaceholder("Filename format")
          .setValue(format)
          .onChange((value) => {
            this.writeContextRow(index, { format: value });
          });
      })
      .addExtraButton((button) => {
        button
          .setIcon("trash")
          .setTooltip(
            this.armedRealm === index
              ? "Click again to remove this Realm; its notes are kept"
              : "Remove this Realm, keeping its notes"
          )
          .onClick(() => {
            // One press asks, the second answers: a Realm is a folder's whole
            // meaning in Weaver, and the button sits beside its name field.
            if (this.armedRealm !== index) {
              this.armedRealm = index;
              this.display();
              return;
            }
            this.armedRealm = null;
            this.removeContextRow(index);
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
      .setDesc("Draw a rounded frame around every entry: the marker row is its top rail label, and its clock row labels the bottom edge with the duration at the left and the moment at the right.")
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

    new Setting(containerEl)
      .setName("Space below each Thread")
      .setDesc("Pixels of air between one Thread's last row and the next Thread. Zero keeps the note's current rhythm.")
      .addSlider((slider) => {
        slider
          .setLimits(0, 48, 1)
          .setValue(this.plugin.settings.threadSpacing)
          .setDynamicTooltip()
          .onChange((value) => {
            this.plugin.settings.threadSpacing = Math.round(value);
            this.commit();
          });
      });

    new Setting(containerEl)
      .setName("Space between branches")
      .setDesc("Pixels of air above each branch inside a Thread, after the Thread's first branch. Zero keeps the note's current rhythm.")
      .addSlider((slider) => {
        slider
          .setLimits(0, 48, 1)
          .setValue(this.plugin.settings.branchSpacing)
          .setDynamicTooltip()
          .onChange((value) => {
            this.plugin.settings.branchSpacing = Math.round(value);
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
