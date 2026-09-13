import { describe, expect, test } from "vitest";
import { emitCModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";
import { rebaseLibrarySourceComments, replaceLibraryIdentity, stripLibraryIdentity, stripLibrarySourceComments } from "../src/backend/library-identity-markers.js";
import type { IrModule } from "../src/ir/ir.js";
import { rebaseSourceLocations, createSourceLineRebaser } from "../src/library/semantic-source.js";
import { fibModule } from "./fixtures/fib-ir.js";

const libraryModule = (): IrModule => ({
  ...fibModule,
  lib: {
    profileName: "identity-emission",
    prefix: "ie_",
    initSymbol: "ie_init",
    sinkRegisterSymbol: "ie_set_sink",
    collectSymbol: null,
    resultResetSymbol: null,
    drainSymbol: null,
    threadInstances: false,
    exports: [],
    trapOverlays: [],
    identity: {
      buildIdSymbol: "ie_build_id",
      abiVersionSymbol: "ie_abi_version",
      buildId: "fedcba9876543210",
      abiVersion: 7,
    },
  },
});

describe("library identity emission", () => {
  test("direct C emission retains the IR-declared identity getters", () => {
    const emitted = emitCModule(libraryModule());
    expect(emitted).toContain("uint64_t ie_build_id(void)");
    expect(emitted).toContain("return UINT64_C(0xfedcba9876543210);");
    expect(emitted).toContain("uint32_t ie_abi_version(void)");
    expect(emitted).toContain("return 7u;");
  });

  test("direct LLVM emission retains the IR-declared identity getters", () => {
    const emitted = emitLlvmModule(libraryModule());
    expect(emitted).toContain("define i64 @ie_build_id()");
    expect(emitted).toContain("identity getter build_id 0xfedcba9876543210");
    expect(emitted).toContain("define i32 @ie_abi_version()");
    expect(emitted).toContain("ret i32 7");
  });

  test("archive program-TU mode suppresses identity definitions in both backends", () => {
    const mod = libraryModule();
    const c = emitCModule(mod, undefined, { emitLibraryIdentity: false });
    const llvm = emitLlvmModule(mod, { emitLibraryIdentity: false });
    expect(c).not.toContain("ie_build_id");
    expect(c).not.toContain("ie_abi_version");
    expect(llvm).not.toContain("@ie_build_id");
    expect(llvm).not.toContain("@ie_abi_version");
    expect(stripLibraryIdentity(emitCModule(mod), "c")).toBe(c);
    expect(stripLibraryIdentity(emitLlvmModule(mod), "llvm")).toBe(llvm);

    mod.lib!.resultResetSymbol = "ie_reset";
    expect(stripLibraryIdentity(emitCModule(mod), "c")).toBe(
      emitCModule(mod, undefined, { emitLibraryIdentity: false }),
    );
    expect(stripLibraryIdentity(emitLlvmModule(mod), "llvm")).toBe(
      emitLlvmModule(mod, { emitLibraryIdentity: false }),
    );
  });

  test("cached public TUs refresh only their identity region", () => {
    const mod = libraryModule();
    const identity = {
      ...mod.lib!.identity!,
      buildId: "0123456789abcdef",
    };
    const expected = libraryModule();
    expected.lib!.identity = identity;
    expect(replaceLibraryIdentity(emitCModule(mod), "c", identity)).toBe(emitCModule(expected));
    expect(replaceLibraryIdentity(emitLlvmModule(mod), "llvm", identity)).toBe(emitLlvmModule(expected));
  });

  test("C source-line annotations can be refreshed and removed", () => {
    const sourceFile = "/tmp/entry[1].ts";
    const emitted = [
      `value(); /* ${sourceFile}:3 */`,
      `const char *text = " /* ${sourceFile}:5 */";`,
      `slot = NULL; /* ${sourceFile}:7 */ /* let slot; */`,
      `other(); /* ${sourceFile}:9 */`,
      "",
    ].join("\n");
    expect(rebaseLibrarySourceComments(emitted, sourceFile, (line) => line + 4)).toBe(
      [
        `value(); /* ${sourceFile}:7 */`,
        `const char *text = " /* ${sourceFile}:5 */";`,
        `slot = NULL; /* ${sourceFile}:11 */ /* let slot; */`,
        `other(); /* ${sourceFile}:13 */`,
        "",
      ].join("\n"),
    );
    expect(stripLibrarySourceComments(emitted, sourceFile)).toBe(
      `value();\nconst char *text = " /* ${sourceFile}:5 */";\nslot = NULL; /* let slot; */\nother();\n`,
    );
  });

  test("cached C annotations match a fresh emission after a comment edit", () => {
    const before = "// old note\nfunction fib() {\n  return 1;\n}\n";
    const after = "/* longer\n * replacement note\n */\n\nfunction fib() {\n  return 1;\n}\n";
    // JSON round-tripping gives every SrcLoc its own object, matching
    // deserialized semantic-cache payloads rather than this fixture's shared
    // hand-written `loc` constant.
    const cachedMod = JSON.parse(JSON.stringify(libraryModule())) as IrModule;
    const oldOffset = before.indexOf("return");
    const setLocations = (value: unknown): void => {
      if (value === null || typeof value !== "object") return;
      const record = value as Record<string, unknown>;
      if (
        record["file"] === "fib.ts" &&
        typeof record["start"] === "number" &&
        typeof record["end"] === "number"
      ) {
        record["start"] = oldOffset;
        record["end"] = oldOffset + "return".length;
        return;
      }
      Object.values(record).forEach(setLocations);
    };
    setLocations(cachedMod);
    const currentMod = structuredClone(cachedMod);
    rebaseSourceLocations(
      currentMod,
      new Map([["fib.ts", before]]),
      new Map([["fib.ts", after]]),
    );
    const restored = rebaseLibrarySourceComments(
      emitCModule(cachedMod, before),
      "fib.ts",
      createSourceLineRebaser("fib.ts", before, after),
    );
    expect(restored).toBe(emitCModule(currentMod, after));
  });
});
