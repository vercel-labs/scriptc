import { describe, expect, test } from "vitest";
import {
  LINK_FEATURE_REQUIREMENTS,
  REQUIRED_LINK_FEATURES,
  noLinkFeatures,
  withRequiredLinkFeatures,
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

describe("the features a link feature requires", () => {
  test("http2 links the http and net units it calls into", () => {
    const features = withRequiredLinkFeatures({ ...noLinkFeatures(), http2: true });
    expect(Object.entries(features).filter(([, on]) => on)).toEqual([
      ["net", true],
      ["http", true],
      ["http2", true],
    ]);
    // The keys and their order are the ones cache keys carry.
    expect(Object.keys(features)).toEqual([...REQUIRED_LINK_FEATURES]);
  });

  test("a program without a requiring feature keeps its value", () => {
    for (const name of REQUIRED_LINK_FEATURES) {
      if (LINK_FEATURE_REQUIREMENTS.some(({ feature }) => feature === name)) continue;
      const alone: NativeLinkFeatures = { ...noLinkFeatures(), [name]: true };
      const before = JSON.stringify(alone);
      expect(withRequiredLinkFeatures(alone)).toBe(alone);
      expect(JSON.stringify(alone), name).toBe(before);
    }
    const optional: NativeLinkFeatures = { ...noLinkFeatures(), workers: true, nodeIsland: true };
    expect(JSON.stringify(withRequiredLinkFeatures(optional))).toBe(
      JSON.stringify({ ...noLinkFeatures(), workers: true, nodeIsland: true }),
    );
  });

  test("each requirement names other features, once", () => {
    const features = LINK_FEATURE_REQUIREMENTS.map(({ feature }) => feature);
    expect(new Set(features).size).toBe(features.length);
    for (const { feature, requires } of LINK_FEATURE_REQUIREMENTS) {
      expect(requires.length, feature).toBeGreaterThan(0);
      expect(requires, feature).not.toContain(feature);
      expect(new Set(requires).size, feature).toBe(requires.length);
    }
  });
});
