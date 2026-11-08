/* One generic declaration compiles into one function per signature, and every
 * instance held as a value adopts the first instance's identity root so that
 * `===`, Map keys and searches see one function. A build that keeps its module
 * state per thread (worker executables, thread-instanced libraries) holds each
 * closure global in thread-local storage, and a thread-local symbol's address
 * is no static initializer's constant: such builds install the root in the
 * entry every context runs, before program code can compare functions. */
import { expect, test } from "vitest";
import { F64, VOID, funcOf, type IrFunction, type IrModule, type IrStmt } from "../../ir/ir.js";
import { emitLlvmModule } from "./emitter.js";

const loc = { file: "identity.ts", start: 0, end: 0 };
const fnType = funcOf([F64], F64);

function instance(name: string, extra: Partial<IrFunction> = {}): IrFunction {
  return {
    name,
    params: [{ name: "x", localId: "x", type: F64 }],
    returnType: F64,
    locals: [{ id: "x", name: "x", type: F64, mutable: false }],
    body: [{ kind: "return", value: { kind: "varRef", localId: "x", type: F64, loc }, loc }],
    loc,
    ...extra,
  };
}

/** The function taken as a value: it enters `fnValues` and gets an interned
 * closure global. */
const held = (fnName: string): IrStmt => ({
  kind: "exprStmt",
  expr: { kind: "closure", fnName, captures: [], type: fnType, loc },
  loc,
});

/** A declaration with two compiled instances, both held as values, the second
 * adopting the first's identity root (arity 1). */
function identityModule(options: { workers?: boolean; threadInstances?: boolean } = {}): IrModule {
  const lib = {
    profileName: "identity",
    prefix: "id_",
    initSymbol: "identity_init",
    sinkRegisterSymbol: "identity_set_sink",
    collectSymbol: null,
    resultResetSymbol: null,
    threadInstances: true,
    exports: [],
    trapOverlays: [],
  } as NonNullable<IrModule["lib"]>;
  return {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    ...(options.workers === true ? { workers: true } : {}),
    ...(options.threadInstances === true ? { lib } : {}),
    functions: [
      {
        name: "main",
        params: [],
        returnType: VOID,
        locals: [],
        body: [held("unbox"), held("unboxInstance")],
        loc,
      },
      instance("unbox"),
      instance("unboxInstance", { identityRoot: "unbox", identityLength: 1 }),
    ],
  };
}

/** The instance's closure global: immortal (`-1`), ordinary function kind
 * bits, arity 1, holding the root's address (or null where the root is
 * thread-local state). */
const INSTANCE_GLOBAL =
  /@sc_fc_unboxInstance = internal global %ScrClosure \{ i64 -1, ptr @sc_w_unboxInstance, i64 0, ptr null, i32 16, i32 1, ptr @sc_fc_unbox, ptr null \}/;
const INSTANCE_GLOBAL_THREAD_LOCAL =
  /@sc_fc_unboxInstance = internal thread_local(?:\(localexec\))? global %ScrClosure \{ i64 -1, ptr @sc_w_unboxInstance, i64 0, ptr null, i32 16, i32 1, ptr null, ptr null \}/;
const INSTALL_ROOT =
  "store ptr @sc_fc_unbox, ptr getelementptr inbounds (%ScrClosure, ptr @sc_fc_unboxInstance, i64 0, i32 6) ; unboxInstance.identity";

/** The text of the function whose definition line starts with `signature`. */
function bodyOf(llvm: string, signature: string): string {
  const start = llvm.indexOf(signature);
  expect(start).toBeGreaterThanOrEqual(0);
  return llvm.slice(start, llvm.indexOf("\n}\n", start));
}

test("a plain build states the adopted identity root in the initializer", () => {
  const llvm = emitLlvmModule(identityModule());
  expect(llvm).toMatch(INSTANCE_GLOBAL);
  // Nothing to install: the root's address is a link-time constant here.
  expect(llvm).not.toContain(INSTALL_ROOT);
});

test("a worker build installs the root into each context's entry", () => {
  const llvm = emitLlvmModule(identityModule({ workers: true }), {
    targetTriple: "x86_64-unknown-linux-gnu",
  });
  expect(llvm).toMatch(INSTANCE_GLOBAL_THREAD_LOCAL);
  // Every thread enters through sc_context_entry (the main thread too), which
  // runs before any program code.
  expect(bodyOf(llvm, "define i32 @sc_context_entry(")).toContain(INSTALL_ROOT);
  expect(bodyOf(llvm, "define i32 @main(")).not.toContain(INSTALL_ROOT);
});

test("a thread-instanced library build installs the root on every init", () => {
  const llvm = emitLlvmModule(identityModule({ threadInstances: true }), {
    targetTriple: "x86_64-unknown-linux-gnu",
  });
  expect(llvm).toMatch(INSTANCE_GLOBAL_THREAD_LOCAL);
  expect(bodyOf(llvm, "define void @identity_init()")).toContain(INSTALL_ROOT);
});
