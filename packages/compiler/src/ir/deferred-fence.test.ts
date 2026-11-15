import { expect, test } from "vitest";
import {
  guardedDeferredFences,
  isDeferredDiagnosticFence,
  markGuardedDeferredFences,
} from "./deferred-fence.js";
import type { IrModule, IrStmt, SrcLoc } from "./ir.js";

test("a message that ends with its diagnostic's tag is a deferred diagnostic", () => {
  expect(
    isDeferredDiagnosticFence(
      "SC2020",
      "'unescape' has no lowering [SC2020 at /app/a.js:4]",
      "/app/a.js",
    ),
  ).toBe(true);
  expect(
    isDeferredDiagnosticFence("SC1090", "library functions as values [SC1090]", "/app/lib.cjs"),
  ).toBe(true);
});

test("a trap or a dispatch refusal carries no tag", () => {
  expect(
    isDeferredDiagnosticFence(
      "SC9002",
      "unreachable: a non-void function completed without returning",
      "/app/a.js",
    ),
  ).toBe(false);
  expect(
    isDeferredDiagnosticFence(
      "SC2020",
      "reading 'x' through an untyped value is not supported",
      "/app/a.mjs",
    ),
  ).toBe(false);
  // Another diagnostic's tag, or a bracket that is not a tag.
  const js = "/app/a.js";
  expect(isDeferredDiagnosticFence("SC2020", "values [SC1090 at /app/a.js:4]", js)).toBe(false);
  expect(isDeferredDiagnosticFence("SC2020", "items [SC2020x]", js)).toBe(false);
  expect(isDeferredDiagnosticFence("SC2020", "[SC2020 at /app/a.js:4] and more", js)).toBe(false);
});

test("a fence in a TypeScript source keeps the plain throw", () => {
  // The typed-array store through an undefined index, which the compiler's
  // own source holds: tagged, and not a JavaScript statement.
  expect(
    isDeferredDiagnosticFence(
      "SC1090",
      "a typed-array write through an undefined index [SC1090 at /app/a.ts:9]",
      "/app/a.ts",
    ),
  ).toBe(false);
});

const at = (file: string): SrcLoc => ({ file, start: 0, end: 1 });
const fence = (message: string, file = "/app/a.js"): IrStmt & { kind: "runtimeFence" } => ({
  kind: "runtimeFence",
  code: "SC2020",
  message,
  loc: at(file),
});

test("marking reaches a deferred fence through nested statements and leaves the others", () => {
  const deferred = fence("'x' has no lowering [SC2020 at /app/a.js:4]");
  const nested = fence("'y' has no lowering [SC2020 at /app/a.js:6]");
  const trap = fence("unreachable: a non-void function completed without returning");
  const typed = fence("a typed-array write [SC2020 at /app/a.ts:9]", "/app/a.ts");
  const body: IrStmt[] = [
    deferred,
    {
      kind: "tryCatch",
      tryBody: [nested],
      catchBody: null,
      catchLocalId: null,
      finallyBody: [],
      loc: at("/app/a.js"),
    },
    trap,
    typed,
  ];
  markGuardedDeferredFences(body);
  expect([deferred.guarded, nested.guarded, trap.guarded, typed.guarded]).toEqual([
    true,
    true,
    undefined,
    undefined,
  ]);
});

test("a module lists each guarded site once, with the refusal and without its tag", () => {
  const guarded = fence("'x' has no lowering [SC2020 at /app/a.js:4]");
  guarded.guarded = true;
  const again = { ...guarded };
  const reported = fence("'y' has no lowering [SC2020 at /app/a.js:6]");
  const mod = {
    sourceFile: "/app/a.js",
    functions: [
      {
        name: "main",
        params: [],
        returnType: { kind: "void" },
        locals: [],
        body: [guarded, again, reported],
        loc: at("/app/a.js"),
      },
    ],
    entry: "main",
  } as unknown as IrModule;
  expect(guardedDeferredFences(mod)).toEqual([
    { code: "SC2020", refusal: "'x' has no lowering", loc: at("/app/a.js") },
  ]);
  expect(guardedDeferredFences({ ...mod, lib: {} } as unknown as IrModule)).toEqual([]);
});
