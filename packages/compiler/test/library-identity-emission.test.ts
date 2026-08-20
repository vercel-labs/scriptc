import { describe, expect, test } from "vitest";
import { emitModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";
import type { IrModule } from "../src/ir/nodes.js";
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
    const emitted = emitModule(libraryModule());
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
    const c = emitModule(mod, undefined, { emitLibraryIdentity: false });
    const llvm = emitLlvmModule(mod, { emitLibraryIdentity: false });
    expect(c).not.toContain("ie_build_id");
    expect(c).not.toContain("ie_abi_version");
    expect(llvm).not.toContain("@ie_build_id");
    expect(llvm).not.toContain("@ie_abi_version");
  });
});
