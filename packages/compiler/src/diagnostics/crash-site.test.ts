import { expect, test } from "vitest";
import { InternalCompilerError } from "../errors.js";
import { compilerCrashDiag, crashSiteOf, isCompilerCrash, noteCrashSite } from "./crash-site.js";

const entry = { file: "/p/main.ts", start: 0, end: 0 };
const inner = { file: "/p/util.ts", start: 40, end: 52 };
const outer = { file: "/p/util.ts", start: 30, end: 90 };

test("an internal compiler error and a checker panic are compiler crashes; other errors are not", () => {
  expect(isCompilerCrash(new InternalCompilerError("lowerer bug: x"))).toBe(true);
  expect(isCompilerCrash(new Error("panic: Value is not an instance of 'TupleType'"))).toBe(true);
  expect(isCompilerCrash(new Error("ENOENT: no such file"))).toBe(false);
  expect(isCompilerCrash("panic: a string, not an error")).toBe(false);
});

test("the first frame to see a crash names its site, and outer frames do not replace it", () => {
  const error = new InternalCompilerError("lowerer bug: x");
  expect(crashSiteOf(error)).toBeNull();
  noteCrashSite(error, () => inner);
  noteCrashSite(error, () => outer);
  expect(crashSiteOf(error)).toEqual(inner);
});

test("a site belongs to the error it was noted for", () => {
  const first = new InternalCompilerError("first");
  const second = new InternalCompilerError("second");
  noteCrashSite(first, () => inner);
  expect(crashSiteOf(second)).toBeNull();
  noteCrashSite(second, () => outer);
  expect(crashSiteOf(second)).toEqual(outer);
  expect(crashSiteOf(first)).toBeNull();
});

test("a broken invariant is SC9001 at its site, with the first line of its message", () => {
  const error = new InternalCompilerError("lowerer bug: unknown class Failure\nmore detail");
  noteCrashSite(error, () => inner);
  expect(compilerCrashDiag(error, entry)).toEqual({
    code: "SC9001",
    message: "internal compiler error: lowerer bug: unknown class Failure — please report this",
    loc: inner,
  });
});

test("a checker panic is SC0004 at its site", () => {
  const error = new Error("panic: Value is not an instance of 'TupleType'\ngoroutine 1");
  noteCrashSite(error, () => inner);
  const diagnostic = compilerCrashDiag(error, entry);
  expect(diagnostic.code).toBe("SC0004");
  expect(diagnostic.loc).toEqual(inner);
  expect(diagnostic.message).toContain("panic: Value is not an instance of 'TupleType'");
  expect(diagnostic.message).not.toContain("goroutine");
});

test("a node without a position names no site, and the next frame's stands", () => {
  const error = new InternalCompilerError("lowerer bug: z");
  noteCrashSite(error, () => {
    throw new Error("no source file");
  });
  expect(crashSiteOf(error)).toBeNull();
  noteCrashSite(error, () => outer);
  expect(crashSiteOf(error)).toEqual(outer);
});

test("a crash no frame noted falls back to the fence's own node", () => {
  const error = new InternalCompilerError("emitter bug: y");
  expect(compilerCrashDiag(error, entry).loc).toEqual(entry);
});
