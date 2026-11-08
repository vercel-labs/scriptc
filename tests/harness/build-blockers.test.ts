/* A build that stops at packages it can neither compile nor run in a Node
 * island reports every blocker the load knows in that one attempt: each such
 * package with the setting that would run it in Node, and the program's own
 * preflight errors beside them. A whole-program load of a large project
 * takes minutes, and a blocker reported alone costs one of those per
 * blocker. */
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { compile, type NodeIslandOptions } from "@scriptc/compiler";

const repoRoot = join(import.meta.dirname, "../..");
const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A program that imports `typegapped` (no declarations, and JavaScript the
 * checker rejects: it never compiles statically) and has `own` as the rest
 * of its entry module. */
function program(own: string): string {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-build-blockers-"));
  scratch.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ private: true, type: "module" }));
  mkdirSync(join(dir, "node_modules"));
  cpSync(
    join(repoRoot, "tests/fixtures/npm-static/node_modules/typegapped"),
    join(dir, "node_modules/typegapped"),
    { recursive: true },
  );
  writeFileSync(
    join(dir, "main.ts"),
    `import label from "typegapped";\n${own}\nconsole.log(label(3));\n`,
  );
  return dir;
}

async function blockers(dir: string, nodeIslands: NodeIslandOptions) {
  const result = await compile(join(dir, "main.ts"), {
    outPath: join(dir, "main"),
    outDir: dir,
    nodeIslands,
  });
  if (result.ok) throw new Error("the build was expected to stop");
  return result.diagnostics;
}

/** The hint of the one diagnostic that refuses the package. */
function packageHint(found: readonly { code: string; message: string; hint?: string }[]): string {
  const refusals = found.filter((d) => d.code === "SC2013");
  expect(refusals.map((d) => d.message)).toEqual([
    expect.stringContaining("cannot compile npm package 'typegapped' statically"),
  ]);
  return refusals[0]?.hint ?? "";
}

const TWO_ERRORS = `const count: number = "three";\nconst flag: boolean = 1;`;

describe("one attempt reports every blocker", () => {
  test("a package that does not compile and the program's own errors come together", async () => {
    const found = await blockers(program(TWO_ERRORS), { mode: "off" });
    packageHint(found);
    // The import of the untyped package is an error of its own beside these
    // two; what matters here is that the program's errors are not held back
    // for a second attempt.
    const own = found.filter((d) => d.code === "SC0001").map((d) => d.message);
    expect(own).toContain("Type 'string' is not assignable to type 'number'.");
    expect(own).toContain("Type 'number' is not assignable to type 'boolean'.");
  });

  test("the package's hint names the setting that runs it in Node", async () => {
    const off = packageHint(await blockers(program(""), { mode: "off" }));
    expect(off).toContain("--node-islands=auto runs every package that does not compile");
    expect(off).toContain("--node-island=typegapped");

    const explicit = packageHint(await blockers(program(""), { mode: "explicit" }));
    expect(explicit).toContain("--node-island=typegapped runs it in Node.js instead");

    const native = packageHint(await blockers(program(""), { native: ["typegapped"] }));
    expect(native).toContain("it is marked native: without the mark it runs in a Node island");
  });
});
