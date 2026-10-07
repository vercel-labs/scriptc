import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import * as ast from "./ts7/ast.js";
import { Ts7Api } from "./ts7/rpc-api.js";
import { Ts7Host } from "./ts7/program-host.js";
import { moduleSourceCandidates } from "./module-source-candidates.js";

test("module candidates preserve nested call order and belong to one program snapshot", () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-module-candidates-"));
  const entry = join(directory, "entry.ts");
  const host = new Ts7Host((options) => new Ts7Api(options), { cwd: directory });
  writeFileSync(entry, "export {};\n");
  host.addVirtualFile(
    entry,
    'import "first"; export { value } from "second";\n' +
      'function deferred() { return outer(require("third"), import(`fourth`)); }\n' +
      'class Task { run() { return local("fifth"); } }\n',
  );
  const first = host.createProgram([entry], { noLib: true, types: [] });
  const walk = vi.spyOn(ast, "walkPreorder");
  try {
    const source = first.getSourceFile(entry)!;
    const candidates = moduleSourceCandidates(first, source);
    expect(candidates.specifiers).toEqual(["first", "second", "third", "fourth"]);
    expect(candidates.calls.map((call) => call.expression.getText())).toEqual([
      "outer",
      "require",
      "import",
      "local",
    ]);
    expect(moduleSourceCandidates(first, source)).toBe(candidates);
    expect(walk).toHaveBeenCalledTimes(1);
    host.addVirtualFile(entry, 'export const next = import("new-target");\n');
    const next = host.createProgram([entry], { noLib: true, types: [] });
    try {
      expect(moduleSourceCandidates(next, next.getSourceFile(entry)!).specifiers).toEqual([
        "new-target",
      ]);
      expect(moduleSourceCandidates(first, source)).toBe(candidates);
      expect(walk).toHaveBeenCalledTimes(2);
    } finally {
      next.dispose();
    }
    first.dispose();
    expect(first.analysis.moduleSourceCandidates.size).toBe(0);
  } finally {
    walk.mockRestore();
    first.dispose();
    host.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
