import { expect, test } from "vitest";
import { emitModule, InternalCompilerError } from "../src/index.js";
import { fibModule } from "./fixtures/fib-ir.js";

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

  expect(() => emitModule(malformed)).toThrow(
    expect.objectContaining({
      constructor: InternalCompilerError,
      message: "emitter bug: closure over unknown function missing",
      name: "InternalCompilerError",
    }),
  );
});
