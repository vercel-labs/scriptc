import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";
import type { IrExpr } from "../src/ir/ir.js";
import { everyStmtList } from "../src/ir/traverse.js";

// fs.existsSync ignores arguments after the path, but Node still evaluates
// them, left to right, before the call. A path the compiler types as bytes
// takes the typed entry point (fs.existsSyncBytes); a path whose type only
// the runtime knows takes the value form (fs.existsSyncValue). Both stage the
// path and then run each ignored argument, so this pins the statement
// sequence each form lowers to.
const cases: { name: string; fn: "fs.existsSyncBytes" | "fs.existsSyncValue"; source: string }[] = [
  {
    name: "a typed Buffer path",
    fn: "fs.existsSyncBytes",
    source: `import * as fs from "node:fs";
const note = (tag) => tag;
const bytes = Buffer.from("x");
fs.existsSync(bytes, note("first ignored"), note("second ignored"));
`,
  },
  {
    name: "a path only the runtime knows",
    fn: "fs.existsSyncValue",
    source: `import * as fs from "node:fs";
const note = (tag) => tag;
const value = JSON.parse('"x"');
fs.existsSync(value, note("first ignored"), note("second ignored"));
`,
  },
];

test.each(cases)(
  "$name stages the path and evaluates the ignored arguments in source order",
  async ({ fn, source }) => {
    const dir = mkdtempSync(join(tmpdir(), "scriptc-fs-exists-extra-"));
    try {
      const entry = join(dir, "main.mjs");
      const output = join(dir, "main.ir.json");
      writeFileSync(entry, source);
      const lowered = await compile(entry, { outputKind: "ir", outDir: dir, outPath: output });
      if (!lowered.ok) throw new Error(JSON.stringify(lowered.diagnostics));
      const module = deserializeModule(readFileSync(output, "utf8"));
      expect(validateModule(module)).toEqual([]);
      const forms: Extract<IrExpr, { kind: "seqExpr" }>[] = [];
      for (const form of module.functions) {
        everyStmtList(form.body, {
          stmt: (stmt) => {
            if (stmt.kind === "exprStmt" && stmt.expr.kind === "seqExpr") forms.push(stmt.expr);
            return true;
          },
          expr: () => true,
        });
      }
      const calls = forms.filter((form) => form.result.kind === "libCall" && form.result.fn === fn);
      expect(calls).toHaveLength(1);
      const [call] = calls;
      // The path is staged first, then one statement per ignored argument.
      expect(call!.stmts.map((stmt) => stmt.kind)).toEqual(["varDecl", "exprStmt", "exprStmt"]);
      const staged = call!.stmts[0];
      if (staged?.kind !== "varDecl") throw new Error("the path must be staged in a local");
      const tags = call!.stmts.slice(1).map((stmt) => {
        // The JS function value is called dynamically, so its argument list
        // is the statement's, in source order.
        const called = stmt.kind === "exprStmt" ? stmt.expr : null;
        if (called?.kind !== "call" && called?.kind !== "callValue")
          throw new Error("each ignored argument must be its own call statement");
        const [raw] = called.args;
        const arg = raw?.kind === "dynFrom" ? raw.value : raw;
        if (arg?.kind !== "strLit") throw new Error("the ignored argument must keep its literal");
        return arg.value;
      });
      expect(tags).toEqual(["first ignored", "second ignored"]);
      if (call!.result.kind !== "libCall") throw new Error("the result must be the entry point");
      const [path] = call!.result.args;
      expect(path?.kind === "varRef" ? path.localId : null).toBe(staged.localId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
