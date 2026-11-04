import { afterAll, expect, test } from "vitest";
import type * as ts from "../frontend/ts7/adapter.js";
import { closeSourceParser, parseSourceFile } from "../frontend/ts7/source-parser-node.js";
import { stripProblem } from "./type-strip.js";

afterAll(() => closeSourceParser());

let serial = 0;
/** The SC8006 construct for a TypeScript module, or null. None of these
 * cases needs the checker (only a plain named import of a type does). */
function problem(source: string): string | null {
  const sf = parseSourceFile(`/virtual/s${serial++}.ts`, source, "ts");
  const program = {
    getTypeChecker(): never {
      throw new Error("the checker is not needed here");
    },
  } as unknown as ts.Program;
  return stripProblem(program, sf)?.construct ?? null;
}

test("a relative specifier Node resolves needs its file extension", () => {
  expect(problem('import { a } from "./a";')).toBe(
    "the relative import './a' without a file extension",
  );
  expect(problem('export { a } from "./a";')).toBe(
    "the relative export from './a' without a file extension",
  );
  expect(problem('const m = await import("./a");')).toBe(
    "the relative import() of './a' without a file extension",
  );
  expect(problem('import "./a.ts";\nexport * from "./b.js";')).toBeNull();
});

test("type-only imports and exports are erased, so their specifiers need no extension", () => {
  expect(problem('import type { A } from "./types";')).toBeNull();
  expect(problem('import type Default from "./types";')).toBeNull();
  expect(problem('export type { A } from "./types";')).toBeNull();
  expect(problem('export type * from "./types";')).toBeNull();
  // An inline `type` element leaves the declaration, which Node still loads.
  expect(problem('import { type A } from "./types";')).toBe(
    "the relative import './types' without a file extension",
  );
});
