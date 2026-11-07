/* Piped-stdin differential tests: the corpus harness closes both
 * children's stdin immediately (programs must see the same empty closed
 * stream), so the stdin DATA paths — chunk delivery to once-'data'
 * listeners, for-await over process.stdin, the race-then-destroy timeout
 * shape — run here, where the harness controls what flows into the pipe
 * and when. Node stays the oracle: same program, same stdin script, same
 * stdout bytes and exit code. SCRIPTC_SAN=1 sanitizes the native side like
 * the corpus. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";
import { eventLoopCases, type StdinScript } from "./event-loop-cases.js";

const repoRoot = join(import.meta.dirname, "../..");
const fixtureDir = join(repoRoot, "tests/fixtures/event-loop");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

interface RunResult {
  stdout: string;
  exitCode: number;
}

function runWithStdin(cmd: string, args: string[], script: StdinScript): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { encoding: "utf8" }, (err, stdout) => {
      const e = err as { code?: unknown } | null;
      if (e && typeof e.code !== "number") {
        reject(err);
        return;
      }
      resolve({ stdout, exitCode: e ? (e.code as number) : 0 });
    });
    void (async () => {
      for (const w of script.writes) {
        await new Promise((r) => setTimeout(r, w.delayMs));
        child.stdin?.write(w.data, w.latin1 ? "latin1" : "utf8");
      }
      if (script.end) child.stdin?.end();
      // Held-open pipes close when the child exits (execFile cleans up).
    })();
  });
}

async function compileFixture(name: string): Promise<string> {
  const file = join(fixtureDir, name);
  const key = createHash("sha256")
    .update(file)
    .update(readFileSync(file))
    .update(sanitize ? "san" : "plain")
    .digest("hex")
    .slice(0, 16);
  const outDir = join(cacheDir, key);
  mkdirSync(outDir, { recursive: true });
  const result = await compile(file, {
    outPath: join(outDir, "program"),
    outDir,
    sanitize,
    // Pinned: piped-stdin timing fixtures were written against the C
    // lane; lane identity stays fixed so a diff means the stdin/event-loop
    // story changed, never that the default backend moved.
    backend: "llvm",
  });
  if (!result.ok) {
    throw new Error(
      "event-loop fixture failed to compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  return result.binaryPath;
}

async function differential(fixture: string, script: StdinScript): Promise<void> {
  const binary = await compileFixture(fixture);
  const [nodeRes, nativeRes] = await Promise.all([
    runWithStdin("node", [join(fixtureDir, fixture)], script),
    runWithStdin(binary, [], script),
  ]);
  expect(nativeRes.stdout).toBe(nodeRes.stdout);
  expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
}

describe("event loop: piped stdin (differential)", () => {
  // The case table lives in event-loop-cases.ts: the Linux lane runs the
  // identical fixtures with the identical stdin scripts in-container.
  test.for(eventLoopCases.map((c) => [c.title, c] as const))("%s", async ([, c]) => {
    await differential(c.fixture, c.script);
  });
});

// Not differential: once an encoding is set Node hands out strings, and a
// consumer compiled for bytes cannot take one. The compiled program refuses
// by name; before, it handed out the raw bytes (a listener that appended its
// chunks printed their decimal values).
test.for([
  [
    "a bytes 'data' listener",
    "stdin-set-encoding-bytes.ts",
    "process.stdin 'data' listener takes a Buffer, but setEncoding makes the chunks strings",
  ],
  [
    "read()",
    "stdin-set-encoding-read.ts",
    "process.stdin.read() answers a Buffer, but setEncoding makes the chunks strings",
  ],
  [
    "for await",
    "stdin-set-encoding-for-await.ts",
    "for await over process.stdin takes Buffers, but setEncoding makes the chunks strings",
  ],
] as const)("stdin under setEncoding: %s is refused by name", async ([, fixture, message]) => {
  const binary = await compileFixture(fixture);
  const result = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
    const child = execFile(binary, [], { encoding: "utf8" }, (err, stdout, stderr) => {
      const e = err as { code?: unknown } | null;
      resolve({ stdout, stderr, code: e && typeof e.code === "number" ? e.code : 0 });
    });
    child.stdin?.end("Say hello\n");
  });
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(message);
  expect(result.stderr).toContain("SC2020");
  expect(result.code).toBe(1);
});
