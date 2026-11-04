/* os.availableParallelism() under cgroup CPU quotas.
 *
 * The number is libuv's uv_available_parallelism: the affinity mask, narrowed
 * on Linux by the CPU limit of the process's cgroup. A host's own limits
 * cannot be varied from a test, so each case runs the fixture twice — once
 * under Node, once compiled — inside a private user and mount namespace that
 * replaces /proc/self/cgroup and /sys/fs/cgroup with a scenario directory.
 * Node is the oracle; the binary must print the same number, and the number
 * must be the one the scenario's files describe.
 *
 * The namespace needs unprivileged user namespaces and mount; the suite is
 * skipped when setting it up does not work here. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const repoRoot = join(import.meta.dirname, "../..");
const fixtureDir = join(repoRoot, "tests/fixtures/os-available-parallelism");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");

/* Each case runs inside the namespace; the fake /sys/fs/cgroup is the case's
 * `files` and /proc/self/cgroup is `cgroup`. `cpus` is the limit those files
 * describe in whole CPUs, or null when none applies (no numeric limit, an
 * unreadable controller file, or — for cgroup v1 — a limit that truncates to
 * zero CPUs, which libuv then ignores). */
interface Scenario {
  name: string;
  cgroup: string;
  files: Record<string, string>;
  cpus: number | null;
}

/* cgroup v1 mounts list the controllers per hierarchy, as in
 * "12:cpu,cpuacct:/x". libuv looks for ":cpu," and takes everything after it
 * as the cgroup path, so such a line yields the path "cpuacct:/x"; the
 * v1-parsed cases lay the files out where that parse looks. */
const V1_CGROUP = "12:cpu,cpuacct:/x\n1:memory:/x\n";

const SCENARIOS: Scenario[] = [
  {
    name: "v2-unlimited",
    cgroup: "0::/\n",
    files: { "cgroup.controllers": "", "cpu.max": "max 100000\n" },
    cpus: null,
  },
  {
    name: "v2-half-cpu",
    cgroup: "0::/\n",
    files: { "cgroup.controllers": "", "cpu.max": "50000 100000\n" },
    cpus: 0, // truncated to 0 and raised to 1
  },
  {
    name: "v2-fractional-cpus",
    cgroup: "0::/\n",
    files: { "cgroup.controllers": "", "cpu.max": "350000 100000\n" },
    cpus: 3,
  },
  {
    name: "v2-above-affinity",
    cgroup: "0::/\n",
    files: { "cgroup.controllers": "", "cpu.max": "6400000 100000\n" },
    cpus: 64,
  },
  {
    name: "v2-nested-outer-limit",
    cgroup: "0::/team/box\n",
    files: {
      "team/box/cgroup.controllers": "",
      "team/box/cpu.max": "50000 100000\n",
      "team/cpu.max": "400000 100000\n",
    },
    cpus: 4, // the outermost numeric limit decides, not the smallest
  },
  {
    name: "v2-nested-inner-limit",
    cgroup: "0::/team/box\n",
    files: {
      "team/box/cgroup.controllers": "",
      "team/box/cpu.max": "200000 100000\n",
      "team/cpu.max": "max 100000\n",
    },
    cpus: 2,
  },
  {
    name: "v2-no-controllers",
    cgroup: "0::/team/box\n",
    files: { "team/box/cpu.max": "200000 100000\n" },
    cpus: null, // cgroup.controllers is missing, so no cgroup limit is read
  },
  {
    name: "v1-controller-list",
    cgroup: V1_CGROUP,
    files: { "x/cpu.cfs_quota_us": "250000\n", "x/cpu.cfs_period_us": "100000\n" },
    cpus: null, // the parse looks under "cpuacct:/x", which holds no files
  },
  {
    name: "v1-quota",
    cgroup: V1_CGROUP,
    files: {
      "cpuacct:/x/cpu.cfs_quota_us": "250000\n",
      "cpuacct:/x/cpu.cfs_period_us": "100000\n",
    },
    cpus: 2,
  },
  {
    name: "v1-half-cpu",
    cgroup: V1_CGROUP,
    files: {
      "cpuacct:/x/cpu.cfs_quota_us": "50000\n",
      "cpuacct:/x/cpu.cfs_period_us": "100000\n",
    },
    cpus: null, // no floor to one CPU here: the limit truncates and is ignored
  },
];

/** Runs `cmd args` with the scenario's cgroup files in place. */
function runInNamespace(
  scenarioDir: string,
  cmd: string,
  args: string[],
): { status: number | null; stdout: string; stderr: string } {
  const child = spawnSync(
    "unshare",
    [
      "-Ur",
      "-m",
      "sh",
      "-c",
      "mount -t tmpfs tmpfs /proc || exit 91\n" +
        "ln -s . /proc/self\n" +
        'cat "$1/proc-cgroup" > /proc/cgroup\n' +
        'mount --bind "$1/sysroot" /sys/fs/cgroup || exit 92\n' +
        "shift\n" +
        'exec "$@"',
      "sh",
      scenarioDir,
      cmd,
      ...args,
    ],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 1 << 20 },
  );
  return { status: child.status, stdout: child.stdout, stderr: child.stderr };
}

/* The mechanism the suite needs is exactly this: a user namespace, a mount
 * namespace, a tmpfs over /proc and a bind mount over /sys/fs/cgroup. */
function fakeCgroupSupported(): boolean {
  const dir = writeScenario({ name: "probe", cgroup: "0::/\n", files: {}, cpus: null });
  return runInNamespace(dir, "true", []).status === 0;
}

async function buildProbe(): Promise<string> {
  const sourceFile = join(fixtureDir, "probe.ts");
  const key = createHash("sha256").update(readFileSync(sourceFile)).digest("hex").slice(0, 16);
  const outDir = join(cacheDir, `os-available-parallelism-${key}`);
  mkdirSync(outDir, { recursive: true });
  const result = await compile(sourceFile, {
    outPath: join(outDir, "probe"),
    outDir,
    sanitize: false,
    backend: "llvm",
  });
  if (!result.ok) {
    throw new Error(
      "availableParallelism probe failed to compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  return result.binaryPath;
}

function writeScenario(scenario: Scenario): string {
  const dir = join(cacheDir, "os-available-parallelism", scenario.name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "sysroot"), { recursive: true });
  writeFileSync(join(dir, "proc-cgroup"), scenario.cgroup);
  for (const [path, contents] of Object.entries(scenario.files)) {
    const file = join(dir, "sysroot", path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, contents);
  }
  return dir;
}

const available = fakeCgroupSupported();

describe.skipIf(!available)("os.availableParallelism under a cgroup CPU quota", () => {
  test("matches Node in every scenario", async () => {
    const binary = await buildProbe();
    const node = process.execPath;
    const reported: Record<string, number> = {};

    for (const scenario of SCENARIOS) {
      const dir = writeScenario(scenario);
      const nodeRun = runInNamespace(dir, node, [
        "-e",
        "console.log(require('node:os').availableParallelism())",
      ]);
      expect(nodeRun.status, `${scenario.name}: Node run\n${nodeRun.stderr}`).toBe(0);
      const run = runInNamespace(dir, binary, []);
      expect(run.status, `${scenario.name}: binary run\n${run.stderr}`).toBe(0);

      const nodeCount = Number(nodeRun.stdout.trim());
      const count = Number(run.stdout.trim());
      expect(Number.isInteger(nodeCount), `${scenario.name}: Node printed ${nodeRun.stdout}`).toBe(
        true,
      );
      reported[scenario.name] = nodeCount;
      expect(count, `${scenario.name}: binary printed ${run.stdout.trim()}`).toBe(nodeCount);
    }

    // The scenarios must describe the numbers recorded from Node, not merely
    // agree with each other: the affinity count when no limit applies, and
    // the limit (at least one CPU) when one does.
    const affinity = reported["v2-unlimited"];
    expect(affinity).toBeGreaterThanOrEqual(1);
    for (const scenario of SCENARIOS) {
      let expected = affinity;
      if (scenario.cpus !== null) {
        expected = Math.max(1, Math.min(affinity, scenario.cpus));
      }
      expect(reported[scenario.name], `${scenario.name}: Node printed`).toBe(expected);
    }
  }, 300_000);
});
