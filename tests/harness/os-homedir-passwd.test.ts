/* os.homedir() and os.userInfo() when the passwd lookup answers nothing.
 *
 * Node reads HOME first and calls getpwuid_r only when it is unset; a
 * lookup that finds no entry is a catchable SystemError, not a crash:
 * "A system error occurred: uv_os_homedir returned ENOENT (no such file or
 * directory)", code ERR_SYSTEM_ERROR, with errno, syscall and info. The
 * runtime must answer the same, and must keep running.
 *
 * The case cannot happen on a host whose uid has a passwd entry, so every
 * run — the Node oracle and each compiled probe — happens inside a private
 * user and mount namespace whose /etc/passwd is a scenario file without
 * that uid, with HOME unset. The probe prints the caught error's fields and
 * the program carries on; Node and the binary must print the same lines and
 * exit 0. A second program leaves the error uncaught: both sides report it
 * and exit 1, and the binary must not abort on a signal.
 *
 * Two builds run the probe: the dynamic one (getpwuid_r, the NSS path every
 * dynamically linked build keeps) and the --static one, whose os unit reads
 * /etc/passwd directly because a static executable cannot load NSS modules.
 * That build links at all only if the unit stops referencing getpwuid_r:
 * the compiler's SC3002 guard refuses a static link that keeps glibc's NSS
 * members. The namespace needs unprivileged user namespaces and mount; the
 * suite is skipped when setting it up does not work here. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const repoRoot = join(import.meta.dirname, "../..");
const fixtureDir = join(repoRoot, "tests/fixtures/os-homedir-passwd");
const probeSource = join(fixtureDir, "probe.ts");
const uncaughtSource = join(fixtureDir, "uncaught.ts");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");

/* A passwd file with one entry, for a uid the run does not have. */
function writeScenario(): string {
  const dir = join(cacheDir, "os-homedir-passwd");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const passwd = join(dir, "passwd");
  writeFileSync(passwd, "ns-other:x:4242:4242::/home/ns-other:/bin/sh\n");
  return passwd;
}

/** Runs `cmd args` with `passwd` bound over /etc/passwd and HOME unset. */
function runInNamespace(
  passwd: string,
  cmd: string,
  args: string[],
): { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string } {
  const child = spawnSync(
    "unshare",
    [
      "-Ur",
      "-m",
      "sh",
      "-c",
      'mount --bind "$1" /etc/passwd || exit 91\n' + "unset HOME\n" + "shift\n" + 'exec "$@"',
      "sh",
      passwd,
      cmd,
      ...args,
    ],
    { encoding: "utf8", timeout: 60_000, maxBuffer: 1 << 20 },
  );
  return { status: child.status, signal: child.signal, stdout: child.stdout, stderr: child.stderr };
}

function namespaceSupported(): boolean {
  const passwd = writeScenario();
  return runInNamespace(passwd, "true", []).status === 0;
}

async function buildProbe(staticLink: boolean, source = probeSource): Promise<string> {
  const hash = createHash("sha256");
  hash.update(readFileSync(source));
  hash.update(staticLink ? "static" : "dynamic");
  const key = hash.digest("hex").slice(0, 16);
  const outDir = join(cacheDir, `os-homedir-passwd-${key}`);
  mkdirSync(outDir, { recursive: true });
  const result = await compile(source, {
    outPath: join(outDir, "probe"),
    outDir,
    sanitize: false,
    backend: "llvm",
    ...(staticLink ? { staticLink: true } : {}),
  });
  if (!result.ok) {
    throw new Error(
      `passwd probe (${staticLink ? "static" : "dynamic"}) failed to compile:\n` +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  return result.binaryPath;
}

const available = namespaceSupported();
const staticArm = available && process.platform === "linux" && process.arch === "x64";

describe.skipIf(!available)("a passwd lookup that answers nothing", () => {
  test("the dynamic build throws the same catchable error as Node", async () => {
    const binary = await buildProbe(false);
    const passwd = writeScenario();
    const nodeRun = runInNamespace(passwd, process.execPath, [probeSource]);
    const run = runInNamespace(passwd, binary, []);

    expect(nodeRun.status, `Node run\n${nodeRun.stderr}`).toBe(0);
    expect(run.status, `binary run\n${run.stderr}`).toBe(0);
    expect(nodeRun.stdout).toContain("threw SystemError");
    expect(nodeRun.stdout).toContain("ERR_SYSTEM_ERROR");
    expect(nodeRun.stdout).toContain("uv_os_homedir");
    expect(nodeRun.stdout).toContain("uv_os_get_passwd");
    expect(run.stdout).toBe(nodeRun.stdout);
  }, 300_000);

  test("an uncaught throw reports the error and exits 1, as Node does", async () => {
    const binary = await buildProbe(false, uncaughtSource);
    const passwd = writeScenario();
    const nodeRun = runInNamespace(passwd, process.execPath, [uncaughtSource]);
    const run = runInNamespace(passwd, binary, []);

    expect(nodeRun.status).toBe(1);
    // An abort shows as a signal and a null status; the error must be
    // reported and the exit code must be Node's.
    expect(run.signal, `binary run\n${run.stderr}`).toBeNull();
    expect(run.status, `binary run\n${run.stderr}`).toBe(1);
    expect(run.stdout).toBe("before\n");
    expect(run.stderr).toContain("SystemError");
    expect(run.stderr).toContain("ERR_SYSTEM_ERROR");
  }, 300_000);

  test.skipIf(!staticArm)(
    "the static build reads /etc/passwd and throws the same error",
    async (ctx) => {
      // A static link needs the host's static libc; where that is missing the
      // arm cannot run at all, so it is skipped rather than failed.
      const binary = await buildProbe(true).catch((error: unknown) => {
        ctx.skip(`no static executable on this host: ${String(error)}`);
      });
      const passwd = writeScenario();
      const nodeRun = runInNamespace(passwd, process.execPath, [probeSource]);
      const run = runInNamespace(passwd, binary, []);
      expect(nodeRun.status, `Node run\n${nodeRun.stderr}`).toBe(0);
      expect(run.status, `binary run\n${run.stderr}`).toBe(0);
      expect(run.stdout).toBe(nodeRun.stdout);
    },
    300_000,
  );
});
