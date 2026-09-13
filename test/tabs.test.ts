/**
 * Bottom-nav tab visibility: the pure filter, and what actually gets persisted on a UserRecord.
 *
 * The stored shape is the *hidden* set, so the risk worth pinning is the empty case - a user who
 * has never touched the setting, and a user who has just switched their last hidden tab back on,
 * must both read as "show everything" rather than as "hide everything".
 */
import { describe, it, expect, beforeEach } from "vitest";
import { getUsers, addUser, setUserHiddenTabs } from "@/lib/kv";
import { HIDEABLE_TABS, visibleTabs } from "@/lib/tabs";
import { fakeRedis } from "./redis-fake";

beforeEach(() => fakeRedis.reset());

describe("visibleTabs", () => {
  it("shows every tab when nothing is hidden", () => {
    expect(visibleTabs(undefined)).toHaveLength(HIDEABLE_TABS.length);
    expect(visibleTabs([])).toHaveLength(HIDEABLE_TABS.length);
  });

  it("drops the hidden ones and keeps the rest in nav order", () => {
    expect(visibleTabs(["reflections", "coach"]).map((t) => t.key)).toEqual([
      "mood",
      "notes",
      "history",
    ]);
  });

  it("never offers Home as hideable - the tracker is the app", () => {
    expect(HIDEABLE_TABS.some((t) => t.key === "home")).toBe(false);
  });
});

describe("setUserHiddenTabs", () => {
  async function hiddenFor(id: string) {
    return (await getUsers()).find((u) => u.id === id)?.hiddenTabs;
  }

  it("stores the set it is given", async () => {
    await addUser("u", "U");
    await setUserHiddenTabs("u", ["reflections", "coach"]);
    expect(await hiddenFor("u")).toEqual(["reflections", "coach"]);
  });

  it("clears back to undefined rather than an empty array", async () => {
    await addUser("u", "U");
    await setUserHiddenTabs("u", ["coach"]);
    await setUserHiddenTabs("u", []);
    expect(await hiddenFor("u")).toBeUndefined();
  });

  it("ignores keys that aren't tabs, so a stale client can't write junk", async () => {
    await addUser("u", "U");
    await setUserHiddenTabs("u", ["coach", "not-a-tab"]);
    expect(await hiddenFor("u")).toEqual(["coach"]);
  });

  it("leaves the other users alone", async () => {
    await addUser("a", "A");
    await addUser("b", "B");
    await setUserHiddenTabs("a", ["coach"]);
    expect(await hiddenFor("b")).toBeUndefined();
  });
});
