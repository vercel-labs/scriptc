import { describe, expect, test } from "vitest";
import { libraryArchiveFeatures } from "./library-pack.js";
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

  test("a program that leaves buffers alone selects neither build", () => {
    const features = libraryArchiveFeatures(base);
    expect(features.mutableBuffers).toBeUndefined();
    expect(effectiveRuntimeFeatures(features)).toMatchObject({
      jsObjectModel: false,
      dynTier: false,
    });
  });
});
