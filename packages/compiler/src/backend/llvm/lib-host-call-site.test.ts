import { expect, test } from "vitest";
import { F64, VOID, type IrExpr, type IrModule } from "../../ir/ir.js";
import { emitLlvmModule } from "./emitter.js";

const loc = { file: "host-call.ts", start: 0, end: 0 };

/** One `tick(1.0, -1.0, 300.0)` channel call: all three integer classes,
 * each a compile-time constant. */
function moduleFor(threadInstances: boolean): IrModule {
  const args: IrExpr[] = [1, -1, 300].map((value) => ({
    kind: "numLit",
    value,
    type: F64,
    loc,
  }));
  return {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    functions: [
      { name: "main", params: [], returnType: VOID, locals: [], body: [], loc },
      {
        name: "call",
        params: [],
        returnType: VOID,
        locals: [],
        body: [
          {
            kind: "exprStmt",
            expr: { kind: "ffiCall", import: "tick", args, type: VOID, loc },
            loc,
          },
          { kind: "return", value: null, loc },
        ],
        loc,
      },
    ],
    lib: {
      profileName: "host-call",
      prefix: "hc_",
      initSymbol: "hc_init",
      sinkRegisterSymbol: "hc_sink",
      collectSymbol: null,
      resultResetSymbol: null,
      threadInstances,
      callbackRegisterSymbol: "hc_set_callback",
      callbacks: [
        {
          name: "tick",
          slot: 0,
          params: ["u32", "i32", "u8"],
          returns: "void",
          unregisteredTrap: "scriptc: library callback 'tick' invoked before registration\n",
        },
      ],
      exports: [],
      trapOverlays: [],
    },
  };
}

test("a native library call site loads the channel and depth from the state object", () => {
  const llvm = emitLlvmModule(moduleFor(false));
  expect(llvm).toContain("@scr_library_host_state = external global %ScrLibHostState");
  expect(llvm).toContain("%ScrLibHostState = type { [32 x ptr], [32 x ptr], i64 }");
  // The registered fn, its ctx, and the depth counter, addressed directly.
  expect(llvm).toContain(
    "getelementptr inbounds %ScrLibHostState, ptr @scr_library_host_state, i64 0, i32 0, i64 0",
  );
  expect(llvm).toContain(
    "getelementptr inbounds %ScrLibHostState, ptr @scr_library_host_state, i64 0, i32 1, i64 0",
  );
  expect(llvm).toContain(
    "getelementptr inbounds %ScrLibHostState, ptr @scr_library_host_state, i64 0, i32 2",
  );
  // The unregistered channel keeps the call site's SC4025 constant.
  expect(llvm).toContain("call void @scr_trap(ptr @sc_lib_cb_trap_0)");
  expect(llvm).not.toContain("scr_library_cb_require");
  expect(llvm).not.toContain("scr_library_callback_begin");
});

test("constant integer arguments are truncated, not sent through the bit helpers", () => {
  const llvm = emitLlvmModule(moduleFor(false));
  expect(llvm).toContain("trunc i64 1 to i32");
  expect(llvm).toContain("trunc i64 -1 to i32");
  expect(llvm).toContain("trunc i64 300 to i32");
  expect(llvm).toMatch(/trunc i32 %t\d+ to i8/);
  expect(llvm).not.toContain("scr_bit_ushr");
  expect(llvm).not.toContain("scr_bit_or");
});

test("a thread-instanced library declares the state thread-local", () => {
  const llvm = emitLlvmModule(moduleFor(true));
  expect(llvm).toContain("@scr_library_host_state = external thread_local global %ScrLibHostState");
});
