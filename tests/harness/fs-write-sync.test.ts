/* fs.writeSync contracts that need harness control over the native process's
 * descriptors. The ordinary byte/error behavior stays in differential corpus
 * 2685; this test controls stdout's pipe state, nonblocking mode, and the
 * process file-size limit to pin the signal-backed descriptor errors. */
import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

describe.skipIf(process.platform === "win32")(
  `fs.writeSync descriptor errors${sanitize ? " (sanitized)" : ""}`,
  () => {
    test("writes preserve descriptor error semantics", async () => {
      const outDir = join(cacheDir, `fs-write-sync${sanitize ? "-san" : ""}`);
      const result = await compile(join(repoRoot, "tests/fixtures/fs-write-sync-sigpipe.ts"), {
        outPath: join(outDir, "sigpipe"),
        outDir,
        sanitize,
        backend: "c",
      });
      if (!result.ok) {
        throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      }
      const launcher = join(outDir, "descriptor-launcher");
      execFileSync("clang", [
        "-std=c11",
        join(repoRoot, "tests/fixtures/fs-write-sync-launch.c"),
        "-o",
        launcher,
      ]);

      const run = async (command: string, args: string[], closeStdout = false) => {
        const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
        child.stdout!.setEncoding("utf8");
        child.stderr!.setEncoding("utf8");
        let stdout = "";
        let stderr = "";
        child.stdout!.on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr!.on("data", (chunk: string) => {
          stderr += chunk;
        });
        if (closeStdout) child.stdout!.destroy();
        const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
          child.on("error", reject);
          child.on("close", (code, signal) => resolve({ code, signal }));
        });
        return { outcome, stdout, stderr };
      };

      const current = await run(result.binaryPath, [], true);
      expect(current.outcome).toEqual({ code: 0, signal: null });
      expect(current.stderr).toBe("caught: Error EPIPE\n");

      const positioned = await run(result.binaryPath, ["positioned"]);
      expect(positioned.outcome).toEqual({ code: 0, signal: null });
      expect(positioned.stdout).toBe("");
      expect(positioned.stderr).toBe("caught: Error ESPIPE ESPIPE: invalid seek, write\n");

      const nonblock = await run(launcher, ["nonblock", result.binaryPath, "eagain"]);
      expect(nonblock.outcome).toEqual({ code: 0, signal: null });
      expect(nonblock.stdout).toBe("");
      expect(nonblock.stderr).toBe(
        "caught: Error EAGAIN EAGAIN: resource temporarily unavailable, write\n",
      );

      const fileLimit = await run(launcher, ["rlimit", result.binaryPath, "efbig"]);
      expect(fileLimit.outcome).toEqual({ code: 0, signal: null });
      expect(fileLimit.stdout).toBe("");
      expect(fileLimit.stderr).toBe(
        "current first: 512\n" +
        "current caught: Error EFBIG EFBIG: file too large, write\n" +
        "positioned first: 512\n" +
        "positioned caught: Error EFBIG EFBIG: file too large, write\n",
      );
    });
  },
);
