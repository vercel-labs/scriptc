import { describe, expect, test } from "vitest";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";
import type { IrModule } from "../src/ir/ir.js";
import { fibModule } from "./fixtures/fib-ir.js";

const libraryModule = (): IrModule => ({
  ...fibModule,
  prototypeOverrideArrayKinds: [2, 3],
  lib: {
    profileName: "array-header-stamps",
    prefix: "st_",
    initSymbol: "st_init",
    sinkRegisterSymbol: "st_set_sink",
    collectSymbol: null,
    resultResetSymbol: null,
    threadInstances: false,
    exports: [],
    trapOverlays: [],
  },
});

/** The body of the function defined by the line that names `signature`, up
 * to the next definition. */
function bodyOf(llvm: string, signature: string): string {
  const start = llvm.indexOf(signature);
  expect(start, `no definition containing ${signature}`).toBeGreaterThanOrEqual(0);
  const end = llvm.indexOf("\ndefine ", start);
  return llvm.slice(start, end < 0 ? undefined : end);
}

describe("prototype-bearing array kinds", () => {
  test("a library initializer sets every kind before compiled code runs", () => {
    const init = bodyOf(emitLlvmModule(libraryModule()), "@st_init(");
    expect(init).toContain("call void @scr_arr_force_cyclic_kind(double 2.0)");
    expect(init).toContain("call void @scr_arr_force_cyclic_kind(double 3.0)");
  });

  test("the executable entry sets them too", () => {
    const entry = bodyOf(
      emitLlvmModule({ ...fibModule, prototypeOverrideArrayKinds: [2, 3] }),
      "define i32 @main(",
    );
    expect(entry).toContain("call void @scr_arr_force_cyclic_kind(double 2.0)");
    expect(entry).toContain("call void @scr_arr_force_cyclic_kind(double 3.0)");
  });
});
