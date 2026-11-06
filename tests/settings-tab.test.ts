import { beforeEach, describe, expect, it } from "vitest";

import { WeaverSettingTab } from "../src/settings-tab";
import WeaverPlugin from "../src/main";
import {
  clearUiSettings,
  createApp,
  instantiatePlugin,
  resetHarness,
  uiSetting,
  uiSettings
} from "../test-support/harness";

async function start(): Promise<{ plugin: WeaverPlugin; tab: WeaverSettingTab }> {
  const plugin = instantiatePlugin(WeaverPlugin, createApp());
  await plugin.onload();

  const tab = new WeaverSettingTab(plugin.app, plugin);
  tab.display();
  return { plugin, tab };
}

beforeEach(() => {
  resetHarness();
});

describe("the settings tab", () => {
  it("offers four groups and the controls that write them", async () => {
    const { plugin } = await start();
    const names = uiSettings().map((setting) => setting.name);

    expect(names).toContain("Write day counters");
    expect(names).toContain("Invitations");
    expect(names).toContain("Offer the built-in rhythm");
    expect(names).toContain("Invitation motion");
    expect(names).toContain("Add Realm");
    expect(names).toContain("Add schedule");
    expect(names).toContain("Day note folder");
    expect(names).toContain("Day note format");
    expect(names).toContain("Equalize entry sizes");
    expect(names).toContain("Entry size");
    expect(names).toContain("Indent step (desktop)");
    expect(names).toContain("Indent step (mobile)");
    expect(names).toContain("Indent maximum level");
    expect(names).toContain("Port em/strong colours");
    expect(names).toContain("Frame follows the indent");
    expect(names).toContain("Space below each Thread");
    expect(names).toContain("Space between branches");
    expect(names).toContain("Debug logging");

    plugin.onunload();
  });

  it("no longer offers the controls whose model is gone", async () => {
    const { plugin } = await start();
    const names = uiSettings().map((setting) => setting.name);

    for (const gone of [
      "Timestamp format",
      "Separator",
      "Maximum dimension depth",
      "Spark target",
      "Colour mode",
      "Current palette",
      "Travel default level",
      "Travel wraps around",
      "Render drafts in the note",
      "Entry weight",
      "Entry date"
    ]) {
      expect(names).not.toContain(gone);
    }

    plugin.onunload();
  });

  it("turns invitations off and on from the Writing group", async () => {
    const { plugin } = await start();

    expect(plugin.settings.portalsEnabled).toBe(true);
    uiSetting("Invitations")?.controls[0]?.change(false);
    expect(plugin.settings.portalsEnabled).toBe(false);

    uiSetting("Invitations")?.controls[0]?.change(true);
    expect(plugin.settings.portalsEnabled).toBe(true);

    uiSetting("Offer the built-in rhythm")?.controls[0]?.change(false);
    expect(plugin.settings.rhythmicPortalsEnabled).toBe(false);

    plugin.onunload();
  });

  it("accepts only the four motion settings, and says what each is", async () => {
    const { plugin } = await start();

    uiSetting("Invitation motion")?.controls[0]?.change("fast");
    expect(plugin.settings.portalMotion).toBe("fast");
    uiSetting("Invitation motion")?.controls[0]?.change("wild");
    expect(plugin.settings.portalMotion).toBe("normal");

    plugin.onunload();
  });

  it("adds a weekly schedule a writer can then edit", async () => {
    const { plugin, tab } = await start();

    uiSetting("Add schedule")?.controls[0]?.click();
    const rows = plugin.settings.portalSchedules as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Morning", contextId: "main", enabled: true, leadMinutes: 11 });
    expect(typeof rows[0]?.["id"]).toBe("string");

    // Its weekdays are its own switches — one control each, after the enabled
    // toggle and the delete button: turning Sunday off narrows the recurrence.
    tab.display();
    uiSetting("Morning")?.controls[2]?.change(false);
    const when = (plugin.settings.portalSchedules as Array<Record<string, unknown>>)[0]?.["when"];
    expect((when as { weekdays: number[] }).weekdays).toEqual([1, 2, 3, 4, 5, 6]);

    plugin.onunload();
  });

  it("writes a change through to the settings and the stylesheet", async () => {
    const { plugin } = await start();

    uiSetting("Equalize entry sizes")?.controls[0]?.change(false);
    expect(plugin.settings.equalizeEntrySizes).toBe(false);
    expect(document.body.classList.contains("weaver-unequal")).toBe(true);

    uiSetting("Frame follows the indent")?.controls[0]?.change(false);
    expect(plugin.settings.frameFollowsIndent).toBe(false);
    expect(document.body.classList.contains("weaver-frame-fixed")).toBe(true);

    uiSetting("Space below each Thread")?.controls[0]?.change(14);
    uiSetting("Space between branches")?.controls[0]?.change(6);
    expect(plugin.settings.threadSpacing).toBe(14);
    expect(plugin.settings.branchSpacing).toBe(6);
    expect(document.getElementById("weaver-style")?.textContent).toContain(
      "--weaver-thread-space: 14px;"
    );
    expect(document.getElementById("weaver-style")?.textContent).toContain(
      "--weaver-branch-space: 6px;"
    );

    plugin.onunload();
  });

  it("adds a Realm only when the form is complete, then lets it be edited in place", async () => {
    const { plugin, tab } = await start();

    // Opening the form writes nothing: an unfinished idea is not a Realm.
    uiSetting("Add Realm")?.controls[0]?.click();
    expect(plugin.settings.contexts).toEqual([]);

    // A name alone is not enough, and the reason is on the form.
    const form = uiSetting("New Realm");
    form?.controls[0]?.change("Spanish");
    expect(uiSetting("New Realm")?.desc).toContain("folder");
    uiSetting("New Realm")?.controls[1]?.change("Spanish/Daily");
    uiSetting("New Realm")?.controls[3]?.click();

    const rows = plugin.settings.contexts as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Spanish", folder: "Spanish/Daily", format: "YYYY.MM.DD" });
    expect(typeof rows[0]?.["id"]).toBe("string");

    // The row is editable in place, and its id never moves.
    const id = rows[0]?.["id"];
    uiSetting("Spanish")?.controls[1]?.change("Spanish/Notes");
    const edited = (plugin.settings.contexts as Array<Record<string, unknown>>)[0];
    expect(edited?.["folder"]).toBe("Spanish/Notes");
    expect(edited?.["id"]).toBe(id);

    tab.display();
    plugin.onunload();
  });

  it("removes a Realm on a second press, never on the first", async () => {
    const { plugin } = await start();
    plugin.settings.contexts = [
      { id: "ctx-a", name: "Spanish", folder: "Spanish/Daily", format: "YYYY.MM.DD" }
    ];

    clearUiSettings();
    const tab = new WeaverSettingTab(plugin.app, plugin);
    tab.display();

    uiSetting("Spanish")?.controls[3]?.click();
    expect(plugin.settings.contexts).toHaveLength(1);

    uiSetting("Spanish")?.controls[3]?.click();
    expect(plugin.settings.contexts).toEqual([]);

    plugin.onunload();
  });

  it("says why a Realm cannot be used instead of storing it quietly", async () => {
    const { plugin } = await start();
    plugin.settings.contexts = [{ id: "ctx-a", name: "Main", folder: "Daily", format: "YYYY.MM.DD" }];

    clearUiSettings();
    const tab = new WeaverSettingTab(plugin.app, plugin);
    tab.display();

    const row = uiSetting("Main")?.desc ?? "";
    expect(row).toContain("already exists");
    // The rejected row is still there: it is the writer's data, not a blank slot.
    expect(plugin.settings.contexts).toHaveLength(1);

    plugin.onunload();
  });

  it("refuses to append to a stored value that is not a list", async () => {
    const { plugin } = await start();
    plugin.settings.contexts = { Spanish: "oops" };

    clearUiSettings();
    const tab = new WeaverSettingTab(plugin.app, plugin);
    tab.display();

    expect(uiSetting("Add Realm")).toBeNull();
    expect(uiSetting("Stored Realms are unreadable")).not.toBeNull();

    uiSetting("Stored Realms are unreadable")?.controls[0]?.click();
    expect(plugin.settings.contexts).toEqual([]);

    plugin.onunload();
  });

  it("ignores an entry size that is not a CSS length", async () => {
    const { plugin } = await start();
    const before = plugin.settings.entrySize;

    uiSetting("Entry size")?.controls[0]?.change("enormous");
    expect(plugin.settings.entrySize).toBe(before);

    uiSetting("Entry size")?.controls[0]?.change("18px");
    expect(plugin.settings.entrySize).toBe("18px");

    plugin.onunload();
  });
});
