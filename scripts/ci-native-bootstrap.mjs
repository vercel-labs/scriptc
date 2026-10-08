import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const PHASES = ["all", "commands", "rebuild", "rebuild-frontend", "rebuild-emit"];

/** The sanitized self-rebuild runs as two halves split at the IR boundary:
 * rebuild-frontend lowers the compiler and compares its IR with the seed's;
 * rebuild-emit emits, links and probes the next generation from the seed's
 * IR. "rebuild" and "all" select both halves in the sanitizer lane. The plain
 * lane keeps its single chained rebuild and fixed-point check. */
export function nativeBootstrapPlan({ phase = "all", sanitize = false } = {}) {
  if (!PHASES.includes(phase)) {
    throw new Error(
      "SCRIPTC_BOOTSTRAP_PHASE must be all, commands, rebuild, rebuild-frontend, or rebuild-emit",
    );
  }
  if (!sanitize && phase.startsWith("rebuild-")) {
    throw new Error(`${phase} is a sanitizer bootstrap phase; the plain lane uses rebuild`);
  }
  const rebuild = sanitize ? ["rebuild-frontend", "rebuild-emit"] : ["rebuild"];
  const phases =
    phase === "all" ? ["commands", ...rebuild] : phase === "rebuild" ? rebuild : [phase];
  return { phases, packageChecks: !sanitize && phases.includes("commands") };
}

export async function runNativeBootstrapChecks(plan, checks) {
  const results = await Promise.allSettled(
    plan.phases.map((phase) => Promise.resolve().then(() => checks[phase]())),
  );
  const failures = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length) throw new AggregateError(failures, "native bootstrap phases failed");
}

export async function runBootstrapAndPackageChecks({
  bootstrap,
  packageReady,
  packageChecks,
  poll = () => setTimeout(100),
}) {
  let finished = false;
  const building = Promise.resolve()
    .then(bootstrap)
    .finally(() => {
      finished = true;
    });
  const packaging = async () => {
    while (!packageReady()) {
      if (finished) throw new Error("bootstrap ended before its native package was ready");
      await poll();
    }
    await packageChecks();
  };
  // Keep the package checks alive after a bootstrap failure and vice versa,
  // then report both results once no child can still read the shared package.
  const results = await Promise.allSettled([building, packaging()]);
  const failures = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length) throw new AggregateError(failures, "native bootstrap checks failed");
}

async function command(executable, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`${executable} exited with ${signal ?? code}`)),
    );
  });
}

async function main() {
  const plan = nativeBootstrapPlan({
    phase: process.env.SCRIPTC_BOOTSTRAP_PHASE,
    sanitize: process.env.SCRIPTC_SAN === "1",
  });
  const bootstrap = () =>
    command("pnpm", ["test", "tests/harness/self-hosting-native-driver.test.ts"]);
  if (!plan.packageChecks) return bootstrap();
  const packageDirectory = process.env.SCRIPTC_BOOTSTRAP_PACKAGE_DIR;
  if (!packageDirectory) throw new Error("SCRIPTC_BOOTSTRAP_PACKAGE_DIR is required");
  const ready = packageDirectory + ".ready";
  rmSync(ready, { force: true });
  await runBootstrapAndPackageChecks({
    bootstrap,
    packageReady: () => existsSync(ready),
    packageChecks: async () => {
      const verify = async () => {
        await command("pnpm", ["test", "packages/runtime/test/glibc-random.test.ts"]);
        await command(process.execPath, [
          "scripts/verify-native-cli.mjs",
          packageDirectory,
          "--run",
        ]);
        await command(process.execPath, ["scripts/smoke-native-install.mjs", packageDirectory]);
      };
      const amazon = () =>
        command("docker", [
          "run",
          "--rm",
          "--volume",
          `${process.cwd()}:/work:ro`,
          "--volume",
          `${packageDirectory}:/native:ro`,
          "--volume",
          `${dirname(dirname(process.execPath))}:/node:ro`,
          "--env",
          "PATH=/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin",
          "--workdir",
          "/work",
          "amazonlinux:2023",
          "sh",
          "-c",
          'set -eu\ndnf install --assumeyes clang tar gzip\ntest "$(getconf GNU_LIBC_VERSION)" = "glibc 2.34"\nnode scripts/smoke-native-install.mjs /native',
        ]);
      const results = await Promise.allSettled([verify(), amazon()]);
      const failures = results
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length) throw new AggregateError(failures, "native package checks failed");
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
