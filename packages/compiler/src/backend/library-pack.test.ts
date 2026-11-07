import { describe, expect, test } from "vitest";
import { libraryArchiveFeatures } from "./library-pack.js";
import { noLinkFeatures } from "./native-link-info-core.js";
import { effectiveRuntimeFeatures } from "./runtime-pack-core.js";

const base = { cPath: "program.ll", outPath: "library.lib.a" };

describe("library archive runtime gates", () => {
  // A program that resizes, grows or detaches a buffer names the views
  // registry's arming entry point from %main. The archive selects its pack
  // objects from these gates, so leaving the fact off drops
  // scr_js_buffers.o and the embedder's link fails on the symbol.
  test("a buffer-moving program selects the views registry and its object model build", () => {
    const features = libraryArchiveFeatures({ ...base, mutableBuffers: true });
    expect(features.mutableBuffers).toBe(true);
    expect(effectiveRuntimeFeatures(features)).toMatchObject({
      mutableBuffers: true,
      jsObjectModel: true,
      dynTier: true,
    });
  });

  // The archive's gates spell every required key by hand (four open changes
  // append to that literal). These two tests hold it to the one list of the
  // keys: it is noLinkFeatures() with the options' gates turned on.
  test("an archive with no gate links no optional runtime", () => {
    expect(libraryArchiveFeatures(base)).toEqual(noLinkFeatures());
  });

  test("each gate turns on its own key and no other", () => {
    const gates = [
      "regex",
      "copying",
      "textDecoderLegacy",
      "bigintBytes",
      "zlib",
      "assert",
      "inspect",
      "dynInvoke",
      "emitter",
      "symbol",
      "bigint",
      "searchParams",
      "x509",
      "dynBuffer",
      "dynTier",
      "mutableBuffers",
    ] as const;
    for (const gate of gates) {
      expect(libraryArchiveFeatures({ ...base, [gate]: true }), gate).toEqual({
        ...noLinkFeatures(),
        [gate]: true,
      });
      // Off is false for a required key and absence for an optional one.
      expect(libraryArchiveFeatures({ ...base, [gate]: false }), gate).toEqual(noLinkFeatures());
    }
  });

  test("a program that leaves buffers alone selects neither build", () => {
    const features = libraryArchiveFeatures(base);
    expect(features.mutableBuffers).toBeUndefined();
    expect(effectiveRuntimeFeatures(features)).toMatchObject({
      jsObjectModel: false,
      dynTier: false,
    });
  });
});
