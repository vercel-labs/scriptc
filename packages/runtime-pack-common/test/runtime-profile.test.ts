import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { expect, test } from "vitest";
import { resolveRuntimeUnitHelper } from "../scripts/runtime-unit.mjs";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const committedProfile = join(
  repoRoot,
  "packages/runtime-pack-common/profiles/linux-x64-gnu.profdata.gz",
);
const manifestPath = join(repoRoot, "packages/runtime-linux-x64-gnu/runtime-pack.json");
const runtimeRoot = join(repoRoot, "packages/runtime");

// Both tests read the committed profile through an LLVM helper new enough to
// apply it; the pack test also needs the Linux x64 pack built with it.
const helper =
  process.platform === "linux" && process.arch === "x64" && existsSync(committedProfile)
    ? await resolveRuntimeUnitHelper(repoRoot, "x86_64-unknown-linux-gnu")
    : null;
const built =
  helper?.features.includes("runtime-unit-profile") === true && existsSync(manifestPath);

// A profile older than the runtime sources loses the counts of every function
// whose control flow changed since it was collected. More than this share of
// the functions it describes means it is due for scripts/refresh-runtime-profile.mjs.
const MAX_MISMATCHED_SHARE = 0.1;
// The same by the profile's counters: a changed hot function loses more of
// the profile's gain than a changed cold one.
const MAX_MISMATCHED_COUNTS_SHARE = 0.05;

test.skipIf(!built)("the committed runtime profile still matches the runtime's speed units", () => {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const match = manifest.flavors?.speed?.runtime_profile;
  expect(match, "the speed flavor was built without the committed runtime profile").toBeDefined();
  const described = match.annotated + match.mismatched;
  expect(match.annotated).toBeGreaterThan(0);
  expect(
    match.mismatched / described,
    `${match.mismatched} of the ${described} runtime functions the profile describes changed since it was collected; run node scripts/refresh-runtime-profile.mjs`,
  ).toBeLessThanOrEqual(MAX_MISMATCHED_SHARE);
  // Helpers that list the matched functions also report their counters.
  if (match.annotated_counts !== undefined) {
    const counts = match.annotated_counts + match.mismatched_counts;
    expect(counts).toBeGreaterThan(0);
    expect(
      match.mismatched_counts / counts,
      `runtime functions that changed since the profile was collected hold ${((100 * match.mismatched_counts) / counts).toFixed(1)}% of its counts (most: ${match.stale.join(", ")}); run node scripts/refresh-runtime-profile.mjs`,
    ).toBeLessThanOrEqual(MAX_MISMATCHED_COUNTS_SHARE);
  }
});

// The committed profile holds the runtime's records only. Training programs'
// functions, and the source paths their names can carry, stay out of the
// repository: refresh-runtime-profile.mjs keeps the functions the
// instrumented runtime units define.
test.skipIf(helper?.features.includes("profile-functions") !== true)(
  "the committed runtime profile names only runtime functions",
  () => {
    const profile = gunzipSync(readFileSync(committedProfile));
    const scratch = mkdtempSync(join(tmpdir(), "scriptc-runtime-profile-"));
    let functions: string[];
    try {
      const unpacked = join(scratch, "runtime.profdata");
      writeFileSync(unpacked, profile);
      ({ functions } = JSON.parse(
        execFileSync(helper!.path, ["profile-functions", "--input", unpacked], {
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
        }),
      ));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    expect(functions.length).toBeGreaterThan(0);

    const sources = new Set(readdirSync(join(runtimeRoot, "src")));
    const identifiers = new Set<string>();
    const collect = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) collect(path);
        else if (/\.(c|h|inc|def)$/.test(entry.name))
          for (const name of readFileSync(path, "latin1").match(/[A-Za-z_]\w*/g) ?? [])
            identifiers.add(name);
      }
    };
    collect(join(runtimeRoot, "src"));
    collect(join(runtimeRoot, "vendor"));

    // A unit's internal functions are named "<unit>.c;<name>" after its
    // runtime source, and its external ones by their C names, which are never
    // a program's `main` or generated `sc_` symbols.
    const foreign = functions.filter((name) => {
      if (/[/\\]/.test(name)) return true;
      const local = /^([\w-]+\.c);(.+)$/.exec(name);
      if (local !== null) return !sources.has(local[1]!);
      return name === "main" || name.startsWith("sc_") || !identifiers.has(name);
    });
    expect(foreign, "records that are not runtime functions").toEqual([]);

    // Nor does any other part of the file hold a path, such as a checkout's.
    const text = profile.toString("latin1");
    const paths = text.match(/(?:\/[\w.-]+){3,}|[A-Za-z]:\\[\w.-]+\\|\.tsx?;/g) ?? [];
    expect(paths, "path strings in the committed profile").toEqual([]);
  },
);
