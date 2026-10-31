/* The Hono application differential: tests/fixtures/hono is a realistic
 * service (hono, @hono/node-server, zod, @hono/zod-validator; CRUD routes,
 * validation errors, middleware, ETags, NDJSON and SSE streams) that runs
 * under Node and as a compiled executable. The shared driver (driver.mjs,
 * always under Node) walks every route over HTTP and prints a transcript
 * of each exchange: status line, raw response headers in wire order, and
 * body. Three legs must match byte for byte between the lanes: the
 * server's stdout, its exit code, and the driver's transcript.
 *
 * The server binds port 0 and reports `PORT <n>` on stderr; the driver's
 * last request (POST /admin/shutdown) stops it. */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import type { CompileResult } from "@scriptc/compiler";

const exec = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const fixtureRoot = join(repoRoot, "tests/fixtures/hono");
const entry = join(fixtureRoot, "server.ts");
const driver = join(fixtureRoot, "driver.mjs");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

interface Lane {
  stdout: string;
  exitCode: number;
  transcript: string;
}

function runLane(cmd: string, args: string[]): Promise<Lane> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: fixtureRoot, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let transcript = "";
    let driverDone: Promise<void> | null = null;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`server timed out\nstderr:\n${stderr}`));
    }, 120_000);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      const match = /^PORT (\d+)$/m.exec(stderr);
      if (driverDone !== null || match === null) return;
      driverDone = new Promise<void>((res, rej) => {
        const d = spawn(process.execPath, [driver, match[1]!], {
          stdio: ["ignore", "pipe", "inherit"],
        });
        d.stdout.on("data", (chunk: Buffer) => (transcript += chunk.toString("utf8")));
        d.on("close", (code) => (code === 0 ? res() : rej(new Error(`driver exited ${code}`))));
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal !== null) return reject(new Error(`server died to ${signal}\nstderr:\n${stderr}`));
      if (driverDone === null) return reject(new Error(`server exited before PORT\n${stderr}`));
      driverDone.then(() => resolve({ stdout, exitCode: code ?? 0, transcript }), reject);
    });
  });
}

/** Compiles server.ts in a child process (the npm graph needs a large heap
 * and isolated compiler state), cached by the fixture's sources. */
async function build(): Promise<string> {
  const hash = createHash("sha256");
  for (const file of [
    "server.ts",
    "src/app.ts",
    "src/clock.ts",
    "src/domain.ts",
    "src/errors.ts",
    "src/events.ts",
    "src/http.ts",
    "src/middleware.ts",
    "src/repository.ts",
    "src/schemas.ts",
    "src/seed.ts",
    "src/service.ts",
    "src/stats.ts",
    "src/routes/books.ts",
    "src/routes/feed.ts",
    "src/routes/members.ts",
  ])
    hash.update(file).update(readFileSync(join(fixtureRoot, file)));
  const key = hash
    .update(sanitize ? "san" : "plain")
    .digest("hex")
    .slice(0, 16);
  const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests", `hono-app-${key}`);
  mkdirSync(outDir, { recursive: true });
  const source = new URL("../../packages/compiler/src/index.ts", import.meta.url).href;
  const child = `import { compile } from ${JSON.stringify(source)};
    import { writeFileSync } from "node:fs";
    const result = await compile(process.argv[1], JSON.parse(process.argv[2]));
    writeFileSync(process.argv[3], JSON.stringify(result));`;
  const resultPath = join(outDir, "compile.json");
  const options = { outDir, outPath: join(outDir, "server"), backend: "llvm", sanitize };
  await exec(
    process.execPath,
    [
      "--max-old-space-size=8192",
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      child,
      entry,
      JSON.stringify(options),
      resultPath,
    ],
    { timeout: 900_000, maxBuffer: 64 * 1024 * 1024 },
  );
  const result = JSON.parse(await readFile(resultPath, "utf8")) as CompileResult;
  if (!result.ok)
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  return result.binaryPath;
}

describe(`hono application differential${sanitize ? " (sanitized)" : ""}`, () => {
  test("the Node lane's transcript is deterministic", async () => {
    const first = await runLane(process.execPath, [entry]);
    const second = await runLane(process.execPath, [entry]);
    expect(first.exitCode).toBe(0);
    expect(first.transcript).toContain("### shutdown: POST /admin/shutdown\nHTTP/1.1 200 OK");
    expect(second).toEqual(first);
  }, 120_000);

  test("every route matches Node byte for byte", async () => {
    const binary = await build();
    const node = await runLane(process.execPath, [entry]);
    const native = await runLane(binary, []);
    expect(native.stdout).toBe(node.stdout);
    expect(native.exitCode).toBe(node.exitCode);
    expect(native.transcript).toBe(node.transcript);
  }, 1_200_000);
});
