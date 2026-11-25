/* The node:test mock calls a program makes, read from the call's syntax and
 * the import its receiver names.
 *
 * `mock.method(object, methodName, …)` replaces a method of the object it
 * names. The module's `mock` is the import binding, whatever local name the
 * import binds (`import { mock as m }`), so the binding is resolved through
 * the checker rather than by its spelling; a test context's tracker
 * (`t.mock.method(…)`) is a `.mock` member read.
 *
 * Two censuses read this: the class-method mutation census, so a class's
 * compiled calls observe the property the mock writes, and the member-call
 * receiver census, which treats a mock creation as an escape of a
 * receiver-reading function — the value a mock returns can be stored under
 * any member name, and the wrapper it makes runs against the receiver its
 * call binds. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";

/** Whether `call` creates a mock through node:test's tracker: `mock.fn(…)`,
 * `mock.method(…)`, or the `t.mock` twins. What it returns is a function
 * that reads the receiver of the call that runs it, and the program can
 * store that value under any member name. */
export function isMockTrackerCall(lowerer: Lowerer, call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (callee.name.text !== "fn" && callee.name.text !== "method") return false;
  return isMockOwner(lowerer, callee.expression);
}

/** The method name `call` replaces, and the object expression it replaces
 * it on. Null for every other call, and for a name that is not a string
 * literal (the mock's lowering reports that form itself). */
export function mockMethodTarget(
  lowerer: Lowerer,
  call: ts.CallExpression,
): { name: string; receiver: ts.Expression } | null {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "method") return null;
  if (!isMockOwner(lowerer, callee.expression)) return null;
  const receiver = call.arguments.nodes[0];
  const nameArg = call.arguments.nodes[1];
  if (receiver === undefined || nameArg === undefined) return null;
  if (ts.isSpreadElement(receiver) || !ts.isStringLiteralLike(nameArg)) return null;
  return { name: nameArg.text, receiver };
}

/** Whether `owner` is the mock tracker a `mock.method` call replaces through:
 * node:test's `mock` export (through the import binding, so an alias counts)
 * or a `.mock` member of a test context. */
export function isMockOwner(lowerer: Lowerer, owner: ts.Expression): boolean {
  if (ts.isIdentifier(owner)) {
    const binding = lowerer.builtinImportOf(owner);
    return binding !== null && binding.module === "test" && binding.member === "mock";
  }
  return ts.isPropertyAccessExpression(owner) && owner.name.text === "mock";
}
