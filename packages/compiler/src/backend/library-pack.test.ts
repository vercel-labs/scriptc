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

  // An exported function that defines one of a function's own protocol
  // members runs that write inside the archive. The archive must carry the
  // SCR_FN_MEMBER_PROPS builds the executable lane links, or the write keeps
  // the default build's SC2020 refusal at run time.
  test("a program that defines a function's own member selects its builds", () => {
    const features = libraryArchiveFeatures({ ...base, fnMemberProps: true });
    expect(features.fnMemberProps).toBe(true);
    const constant = libraryArchiveFeatures(base).fnMemberProps;
    expect(constant === undefined || constant === false).toBe(true);
  });
});
