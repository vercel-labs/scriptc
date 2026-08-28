import { expect, test } from "vitest";
import { emitCModule, InternalCompilerError } from "../src/index.js";
import { resolveCc } from "../src/backend/native-toolchain.js";
import { deserializeModule } from "../src/ir/serialize.js";
import { fibModule } from "./fixtures/fib-ir.js";

function captureError(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("expected the operation to throw");
}

test("InternalCompilerError is a public, identifiable compiler failure", () => {
  const cause = new Error("filesystem failure");
  const error = new InternalCompilerError("emitter bug: broken invariant", { cause });

  expect(error).toBeInstanceOf(Error);
  expect(error).toBeInstanceOf(InternalCompilerError);
  expect(error.name).toBe("InternalCompilerError");
  expect(error.message).toBe("emitter bug: broken invariant");
  expect(error.cause).toBe(cause);
});

test("emitter invariant failures preserve their message and public type", () => {
  const malformed = structuredClone(fibModule);
  const main = malformed.functions.find((fn) => fn.name === "__main")!;
  const statement = main.body[0]!;
  if (statement.kind !== "exprStmt" || statement.expr.kind !== "intrinsic") {
    throw new Error("fixture lost its console.log call");
  }
  statement.expr.args[0] = {
    kind: "closure",
    fnName: "missing",
    captures: [],
    type: { kind: "func", params: [], returnType: { kind: "void" } },
    loc: statement.loc,
  };

  expect(() => emitCModule(malformed)).toThrow(
    expect.objectContaining({
      constructor: InternalCompilerError,
      message: "emitter bug: closure over unknown function missing",
      name: "InternalCompilerError",
    }),
  );
});

test("caller configuration and input failures are not internal compiler errors", () => {
  const configuration = captureError(() => resolveCc({ SCRIPTC_CC: "unsupported" }));
  expect(configuration.message).toContain("unknown SCRIPTC_CC");
  expect(configuration).not.toBeInstanceOf(InternalCompilerError);

  const externalIr = captureError(() => deserializeModule('{"irVersion": 5}'));
  expect(externalIr.message).toContain("IR version mismatch");
  expect(externalIr).not.toBeInstanceOf(InternalCompilerError);
});
