import { describe, expect, it } from "vitest";
import { dampenPull, isVerticalPull, PULL_MAX, PULL_THRESHOLD, shouldRefresh } from "@/lib/pull";

describe("pull to refresh", () => {
  it("ignores an upward or tiny move and caps a long one", () => {
    expect(dampenPull(0)).toBe(0);
    expect(dampenPull(-20)).toBe(0);
    expect(dampenPull(40)).toBe(20);
    expect(dampenPull(1000)).toBe(PULL_MAX);
  });

  it("treats a downward move as a pull and a sideways one as not", () => {
    expect(isVerticalPull(4, 30)).toBe(true);
    expect(isVerticalPull(40, 10)).toBe(false);
    expect(isVerticalPull(0, 8)).toBe(false);
  });

  it("reloads only once the pull has crossed the line", () => {
    expect(shouldRefresh(PULL_THRESHOLD - 1)).toBe(false);
    expect(shouldRefresh(PULL_THRESHOLD)).toBe(true);
  });
});
