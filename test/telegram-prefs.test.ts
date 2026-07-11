import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync, writeFileSync } from "node:fs";
import { loadPrefsStore } from "../src/telegram-prefs.js";

const FILE = ".state/test-prefs.json";

beforeEach(() => { if (existsSync(FILE)) rmSync(FILE); });
afterEach(() => { if (existsSync(FILE)) rmSync(FILE); });

describe("loadPrefsStore", () => {
  it("returns undefined for an unset user", () => {
    expect(loadPrefsStore(FILE).get(1)).toBeUndefined();
  });

  it("persists a set value across reloads", () => {
    loadPrefsStore(FILE).set(1, "flux2-pro");
    expect(loadPrefsStore(FILE).get(1)).toBe("flux2-pro");
  });

  it("clears a value when set to null", () => {
    const s = loadPrefsStore(FILE);
    s.set(1, "flux2-pro");
    s.set(1, null);
    expect(s.get(1)).toBeUndefined();
    expect(loadPrefsStore(FILE).get(1)).toBeUndefined();
  });

  it("starts empty on a corrupt file", () => {
    loadPrefsStore(FILE).set(1, "flux2-pro");
    writeFileSync(FILE, "not json{");
    expect(loadPrefsStore(FILE).get(1)).toBeUndefined();
  });
});
