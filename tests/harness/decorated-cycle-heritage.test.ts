/* A decorated subclass whose `extends` clause reads a class of an import
 * cycle before that class initialized: the decorator's factory runs first —
 * decorator expressions evaluate before the heritage, as tsc's decorator
 * emit does — and the heritage read then throws Node's temporal-dead-zone
 * ReferenceError. The corpus cannot pin this: its `@tsc-decorators` oracle
 * emits one file per module but keeps the `.ts` specifiers, so a decorator
 * program with more than one module does not run there. */
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

test("a decorated subclass reads its cycle class after the decorator factories", async () => {
  const dir = join(repoRoot, "node_modules/.cache/scriptc-tests", "decorated-cycle-heritage");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "main.ts"), `import "./a.ts";\n\nconsole.log("main never runs");\n`);
  writeFileSync(
    join(dir, "a.ts"),
    `import { order } from "./b.ts";\n\nexport const early = order;\nexport class Base {}\n`,
  );
  writeFileSync(
    join(dir, "b.ts"),
    `import { Base } from "./a.ts";

function applied(value: typeof Sub): void {
  console.log("applied");
}

function makeDecorator(): typeof applied {
  console.log("factory");
  return applied;
}

@makeDecorator()
export class Sub extends Base {}

export const order = "ok";
`,
  );
  const result = await compile(join(dir, "main.ts"), {
    outPath: join(dir, "main"),
    outDir: dir,
    sanitize,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  const run = await execFileAsync(result.binaryPath, [], { cwd: dir, encoding: "utf8" }).catch(
    (error: { stdout?: string; code?: number }) => error,
  );
  // The factory's line prints; the application and main never run.
  expect(run.stdout).toBe("factory\n");
  expect(run.code).toBe(1);
});
