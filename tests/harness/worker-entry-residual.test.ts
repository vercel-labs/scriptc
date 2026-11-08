/* wave2 §4.2 fallback B: a Worker entry the build cannot fully bound still
 * compiles — its bounded arm is a native thread — and the residual throws
 * ERR_SCRIPTC_WORKER_ENTRY at run time instead of starting a file the
 * binary did not compile. Node would start a Worker there, so this is a
 * deliberate, named divergence; 2b's island Worker replaces the throw. */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const exec = promisify(execFile);

const WORKER = `import { parentPort, workerData } from "node:worker_threads";

parentPort!.postMessage((workerData as number) * 2);
`;

const PROGRAM = `import { Worker } from "node:worker_threads";

function defaultWorkerUrl(): URL {
  return new URL("./worker.ts", import.meta.url);
}

const entry = process.argv[2] === undefined ? defaultWorkerUrl() : process.argv[2];
const worker = new Worker(entry, { workerData: 21 });
worker.once("message", (value: number) => console.log("worker", value));
`;

test(
  "the bounded arm runs natively and the residual throws by name",
  { timeout: 300_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-worker-entry-"));
    try {
      await writeFile(join(dir, "worker.ts"), WORKER);
      await writeFile(join(dir, "main.ts"), PROGRAM);
      const result = await compile(join(dir, "main.ts"), {
        backend: "llvm",
        outDir: dir,
        outPath: join(dir, "entry"),
      });
      expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
      if (!result.ok) return;
      const bounded = await exec(result.binaryPath, [], { timeout: 120_000 });
      expect(bounded.stdout.trim()).toBe("worker 42");
      // A string that names the compiled entry with dot segments is the
      // same file to Node, which resolves the filename before it loads it.
      for (const spelled of [join(dir, ".") + "/./worker.ts", `${dir}/missing/../worker.ts`]) {
        const dotted = await exec(result.binaryPath, [spelled], { timeout: 120_000 });
        expect(dotted.stdout.trim()).toBe("worker 42");
      }
      const residual = await exec(result.binaryPath, ["./worker.ts"], {
        timeout: 120_000,
      }).catch((error: unknown) => error as { code: number; stderr: string });
      expect(residual.code).toBe(1);
      expect(residual.stderr).toContain("ERR_SCRIPTC_WORKER_ENTRY");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
