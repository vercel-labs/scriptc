import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

test.each(["llvm"] as const)(
  "native builtin values refuse unimplemented modules and exports (%s)",
  async (backend) => {
    const dir = mkdtempSync("/tmp/scriptc-builtin-values-");
    try {
      const entry = join(dir, "main.js");
      writeFileSync(
        entry,
        `
const load = process.getBuiltinModule;
try { load("node:fs"); } catch (error) { console.log(error.code, error.message.includes("native builtin 'fs'")); }
const path = load("path");
console.log(JSON.stringify(path.parse("/a")));
const worker = load("worker_threads");
try { console.log(worker.Worker); } catch (error) { console.log(error.code, error.message.includes("worker_threads.Worker")); }
console.log(path.posix.join("still", "works"), worker.isMainThread);
var scope = globalThis;
try { console.log(scope.process); } catch (error) { console.log(error.code, error.message.includes("globalThis.process")); }
const segmenter = new Intl.Segmenter();
try { segmenter.resolvedOptions(); } catch (error) { console.log(error.message.includes("Intl.Segmenter locale negotiation")); }
try { console.log(segmenter.segment); } catch (error) { console.log(error.message.includes("not supported")); }
`,
      );
      const result = await compile(entry, {
        backend,
        sanitize: process.env["SCRIPTC_SAN"] === "1",
        outDir: dir,
        outPath: join(dir, "program"),
      });
      expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
      if (!result.ok) return;
      const child = spawnSync(result.binaryPath, [], { encoding: "utf8" });
      expect(child.status, child.stderr).toBe(0);
      expect(child.stderr).toBe("");
      expect(child.stdout).toBe(
        'SC2020 true\n{"root":"/","dir":"/","base":"a","ext":"","name":"a"}\nSC2020 true\nstill/works true\nSC2020 true\ntrue\ntrue\n',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
