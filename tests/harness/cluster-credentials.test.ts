/* A cluster worker's credentials cannot be dropped before exec on this
 * runtime: the launch re-executes the artifact, which runs the dynamic
 * loader with the primary's identity before any runtime code could drop
 * privileges. cluster.fork() therefore refuses a credentialed
 * setupPrimary instead of treating the drop as enforced. The program below
 * prints the refusal; before the refusal existed it printed "forked" and
 * left the credential drop to the worker. */
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests/cluster-credentials");

const SOURCE = `import * as cluster from "node:cluster";

if (cluster.isPrimary) {
  cluster.setupPrimary({ uid: 65534, gid: 65534 });
  try {
    cluster.fork();
    console.log("forked");
  } catch (error) {
    console.log("refused", (error as { code?: string }).code);
  }
}
`;

test.skipIf(process.platform === "win32")(
  "a credentialed cluster launch is refused before it runs the artifact",
  async () => {
    const outDir = join(cacheDir, "refused");
    mkdirSync(outDir, { recursive: true });
    const sourcePath = join(outDir, "main.ts");
    writeFileSync(sourcePath, SOURCE);
    const result = await compile(sourcePath, {
      outPath: join(outDir, "program"),
      outDir,
      backend: "llvm",
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const run = await execFileAsync(result.binaryPath, [], { timeout: 30_000 });
    expect(run.stdout.trim()).toBe("refused SC2020");
  },
  60_000,
);
