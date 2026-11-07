/* Reason ids for refusal messages that carry none (DESIGN.md §1.3): the
 * shapes a program meets in the wild decide whether a module may run in a
 * Node island, so the table keeps them mapped to their rule. */
import { describe, expect, test } from "vitest";
import type { ScrDiagnostic } from "../diagnostics/diagnostic.js";
import { classifyDiagnostic } from "./classify.js";

type Code = ScrDiagnostic["code"];

function refusal(code: Code, message: string): ScrDiagnostic {
  return { code, message, loc: { file: "/app/src/module.ts", start: 0, end: 0 } };
}

const CASES: { reason: string; rule: string; code: Code; message: string }[] = [
  {
    reason: "cjs-namespace",
    rule: "R1.2",
    code: "SC1090",
    message:
      "dynamic import of the program's own CommonJS module 'highlight.js/lib/index.js' (its namespace comes from module.exports through Node's CJS lexer, which has no compiled story — require it, or import it statically) is not supported yet",
  },
  {
    reason: "dynamic-import",
    rule: "R1.2",
    code: "SC1090",
    message:
      "dynamic import() of computed specifiers (the module graph resolves at build time — the specifier must be a string literal) are not supported yet",
  },
  {
    reason: "dynamic-resolve",
    rule: "R1.2",
    code: "SC2020",
    message:
      "'import.meta.resolve with a runtime-computed specifier' is part of the standard library types but has no scriptc lowering yet",
  },
  {
    reason: "worker-entry",
    rule: "R1.2",
    code: "SC2020",
    message:
      "'this Worker entry point' is part of the standard library types but has no scriptc lowering yet",
  },
  {
    reason: "host-class-base",
    rule: "R1.6",
    code: "SC1090",
    message: "extending classes not declared in the program ('WebSocket') is not supported yet",
  },
  {
    reason: "dynamic-require",
    rule: "R1.2",
    code: "SC2020",
    message: "'require' is typed by @types/node but has no scriptc lowering yet",
  },
  {
    reason: "dynamic-require",
    rule: "R1.2",
    code: "SC2020",
    message:
      "'createRequire's require with a computed specifier or this argument shape' is part of the standard library types but has no scriptc lowering yet",
  },
];

describe("refusal messages", () => {
  for (const c of CASES) {
    test(c.reason, () => {
      const reason = classifyDiagnostic(refusal(c.code, c.message), "refusal");
      expect(reason.reason).toBe(c.reason);
      expect(reason.rule).toBe(c.rule);
      expect(reason.class).toBe("runtime");
    });
  }

  test("a construct the runtime cannot help with stays a gap", () => {
    const reason = classifyDiagnostic(
      refusal("SC1090", "union discriminant reads are not supported yet"),
      "refusal",
    );
    expect(reason.class).toBe("gap");
    expect(reason.rule).toBeNull();
  });
});
