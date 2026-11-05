/* Deferred Node island modules (scope-B NI-7) where what the build-time
 * probe records decides the program's behaviour: a load that changes
 * another island module's exports, an export getter that runs code, a
 * file of the package that is missing when the build probes it, and stdio
 * that is a pipe at build time and a terminal when the program runs. The
 * fixtures are in tests/fixtures/node-island/deferral. Needs a libnode pack
 * in SCRIPTC_LIBNODE (libnode.ts). */
import { execFile, spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { libnodePack } from "./libnode.js";

const execFileAsync = promisify(execFile);

/** stdout of `binary` run under a pseudo-terminal by script(1). util-linux's
 * takes the command with -c. The BSD one on macOS takes it after the
 * transcript file, needs a stdin that is not a socket, and echoes the EOF
 * it forwards from /dev/null as ^D and two backspaces. */
async function underTerminal(binary: string, env: NodeJS.ProcessEnv): Promise<string> {
  if (process.platform !== "darwin")
    return (await execFileAsync("script", ["-qec", binary, "/dev/null"], { env, encoding: "utf8" }))
      .stdout;
  const child = spawn("script", ["-q", "/dev/null", binary], {
    env,
    stdio: ["ignore", "pipe", "inherit"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  expect(code).toBe(0);
  return stdout.replaceAll("^D\b\b", "");
}
const repoRoot = join(import.meta.dirname, "../..");
const cli = join(repoRoot, "packages/cli/dist/main.js");
const fixtures = join(repoRoot, "tests/fixtures/node-island/deferral");
const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests/node-island-deferral");
const skip = libnodePack() === null;

/** Builds a fixture with the deferral trace on; answers the binary and the
 * build's trace lines. */
async function build(name: string): Promise<{ binary: string; trace: string[] }> {
  const dir = join(outDir, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const binary = join(dir, "main");
  const env = {
    ...process.env,
    SCRIPTC_NODE_ISLANDS_TRACE: "defer",
    SCRIPTC_CACHE_DIR: join(dir, "build-cache"),
  };
  const { stderr } = await execFileAsync(
    process.execPath,
    [cli, "build", join(fixtures, name, "main.ts"), "-o", binary],
    { env, encoding: "utf8" },
  );
  return { binary, trace: stderr.split("\n").filter((l) => l.startsWith("[node-islands] ")) };
}

async function run(binary: string): Promise<string> {
  const env = { ...process.env, XDG_CACHE_HOME: join(outDir, "cache") };
  return (await execFileAsync(binary, [], { env, encoding: "utf8" })).stdout;
}

describe.skipIf(skip)("deferred Node island modules", () => {
  test("a load that changes another island module's exports defers neither", async () => {
    const { binary, trace } = await build("mutate");
    expect(trace.some((l) => /eager .*pkg-a.*a later island module's load changes/.test(l))).toBe(
      true,
    );
    expect(
      trace.some((l) => /eager .*pkg-b.*changes another island module's exports/.test(l)),
    ).toBe(true);
    expect(await run(binary)).toBe("set by pkg-b true\n");
  }, 300_000);

  test("a load that changes an object exported through a getter defers neither", async () => {
    const { binary, trace } = await build("mutate-getter");
    expect(trace.some((l) => /eager .*pkg-a.*a later island module's load changes/.test(l))).toBe(
      true,
    );
    expect(
      trace.some((l) => /eager .*pkg-b.*changes another island module's exports/.test(l)),
    ).toBe(true);
    expect(await run(binary)).toBe("set by pkg-b true\n");
  }, 300_000);

  test("an export getter that runs code runs on every read", async () => {
    const { binary } = await build("getter");
    expect(await run(binary)).toBe("counter 1 2\n");
  }, 300_000);

  test("an export getter that reads a member runs on every read", async () => {
    const { binary } = await build("getter-member");
    expect(await run(binary)).toBe("counter 1 2\n");
  }, 300_000);

  test("a package file missing when the build probes keeps the module eager", async () => {
    const { binary, trace } = await build("missing-file");
    expect(trace.some((l) => /eager .*probe-pkg.*existsSync/.test(l))).toBe(true);
    expect(await run(binary)).toBe("extra false\n");
  }, 300_000);

  test("stdio's terminal state at run time is the program's", async () => {
    const { binary } = await build("tty");
    expect(await run(binary)).toBe("color false\n");
    // Under a pseudo-terminal the module sees a terminal, as under Node.
    const env = { ...process.env, XDG_CACHE_HOME: join(outDir, "cache") };
    expect((await underTerminal(binary, env)).replace(/\r/g, "")).toBe("color true\n");
  }, 300_000);
});
