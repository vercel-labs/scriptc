import { describe, expect, test } from "vitest";
import {
  REQUIRED_LINK_FEATURES,
  noLinkFeatures,
  type NativeLinkFeatures,
} from "./native-link-info-core.js";

describe("the required link feature keys", () => {
  test("a program with no feature spells every required key off and nothing else", () => {
    const features = noLinkFeatures();
    // The same keys in the same order: the list is read off this value.
    expect(Object.keys(features)).toEqual([...REQUIRED_LINK_FEATURES]);
    expect(Object.values(features).every((value) => value === false)).toBe(true);
    expect(new Set(REQUIRED_LINK_FEATURES).size).toBe(REQUIRED_LINK_FEATURES.length);
    expect(REQUIRED_LINK_FEATURES).toContain("fetch");
    // An optional key is absent when off, never false.
    expect("workers" in features).toBe(false);
  });

  test("each call builds its own value, and turning a key on keeps its place", () => {
    const first = noLinkFeatures();
    first.fetch = true;
    expect(noLinkFeatures().fetch).toBe(false);
    // The warm-cache profiles turn on one feature this way.
    const warmed: NativeLinkFeatures = { ...noLinkFeatures(), fetch: true };
    expect(Object.keys(warmed)).toEqual([...REQUIRED_LINK_FEATURES]);
    expect(Object.entries(warmed).filter(([, on]) => on)).toEqual([["fetch", true]]);
  });
});
