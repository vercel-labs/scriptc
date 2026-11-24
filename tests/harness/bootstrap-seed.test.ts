import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { load } from "js-yaml";
import { expect, test } from "vitest";
import { seedBuildEnvironment, verifyBootstrapSeed } from "../../scripts/bootstrap-seed.mjs";

test("bootstrap artifacts require a complete seed from the same inputs, lane, and path", () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-seed-contract-"));
  try {
    const metadata = { schema: 2, inputs: "inputs", sanitize: true, directory };
    writeFileSync(join(directory, "bootstrap-seed.json"), JSON.stringify(metadata));
    expect(() => verifyBootstrapSeed(directory, "inputs", true)).toThrow("missing");
    for (const path of [
      "distribution/bin/scriptc",
      "distribution/bin/scriptc.json",
      ".scriptc/distribution-seed/cli.ir.json",
      ".scriptc/distribution-seed/cli.ll",
      ".scriptc/distribution-seed/compiler.ffi.json",
    ]) {
      const file = join(directory, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "fixture");
    }
    expect(() => verifyBootstrapSeed(directory, "inputs", true)).not.toThrow();
    expect(() => verifyBootstrapSeed(directory, "other", true)).toThrow("identity");
    expect(() => verifyBootstrapSeed(directory, "inputs", false)).toThrow("identity");
    expect(() => verifyBootstrapSeed(directory, undefined, true)).toThrow("identity");
    writeFileSync(
      join(directory, "bootstrap-seed.json"),
      JSON.stringify({ ...metadata, directory: "/different" }),
    );
    expect(() => verifyBootstrapSeed(directory, "inputs", true)).toThrow("identity");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("seeds build without the function layout in both lanes, shared or not", () => {
  for (const sanitize of [false, true])
    expect(seedBuildEnvironment(sanitize)).toEqual({
      SCRIPTC_SAN: sanitize ? "1" : "",
      SCRIPTC_NATIVE_EMIT_IR: "1",
      SCRIPTC_NATIVE_OPTIMIZATION: sanitize ? "dev" : "release",
      SCRIPTC_NATIVE_LAYOUT: "",
    });
  // The bootstrap test builds its own seed when CI shares none.
  const driver = readFileSync(
    new URL("./self-hosting-native-driver.test.ts", import.meta.url),
    "utf8",
  );
  expect(driver).toContain("...seedBuildEnvironment(sanitize)");
});

test("CI restores each seed only into its matching instrumented bootstrap lane", () => {
  const workflow = load(
    readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"),
  ) as {
    jobs: Record<
      string,
      {
        needs?: string | string[];
        strategy: { matrix: { flavor?: string[]; include?: { flavor: string }[] } };
        env: Record<string, string>;
        steps: {
          uses?: string;
          id?: string;
          if?: string;
          "continue-on-error"?: boolean;
          with?: Record<string, unknown>;
          env?: Record<string, string>;
          run?: string;
        }[];
      }
    >;
  };
  const seed = workflow.jobs.bootstrap_seed!;
  const checks = workflow.jobs.bootstrap!;
  const dependencies = Array.isArray(checks.needs) ? checks.needs : [checks.needs];
  expect(dependencies).toContain("bootstrap_seed");
  expect(
    seed.steps
      .filter((step) => step.uses === "./.github/actions/native-packages")
      .map((step) => step.with?.target),
  ).toEqual(["linux-x64-gnu", "wasm32-wasi"]);
  for (const step of checks.steps.filter(
    (step) => step.uses === "./.github/actions/native-packages",
  )) {
    expect(step.if).toBe("matrix.phase == 'commands'");
  }
  // Each bootstrap job restores the seed of a flavor the seed job builds.
  const checkFlavors = new Set(checks.strategy.matrix.include?.map((job) => job.flavor));
  expect([...checkFlavors].toSorted()).toEqual(seed.strategy.matrix.flavor);
  expect(seed.env.SCRIPTC_SAN).toBe(checks.env.SCRIPTC_SAN);
  const prepare = seed.steps.find((step) => step.run === "node scripts/bootstrap-seed.mjs")!;
  const execute = checks.steps.find((step) =>
    step.run?.split("\n").includes("node scripts/ci-native-bootstrap.mjs"),
  )!;
  // The sanitized seed's build needs more memory than the runner has: swap backs it.
  const swap = seed.steps.findIndex((step) => step.run?.includes("swapon /mnt/swapfile"));
  expect(seed.steps[swap]?.if).toBe(
    "matrix.flavor == 'san' && steps.seed.outputs.cache-hit != 'true'",
  );
  expect(swap).toBeLessThan(seed.steps.indexOf(prepare));
  expect(prepare.env?.SCRIPTC_BOOTSTRAP_SEED_DIRECTORY).toBe("${{ runner.temp }}/native-bootstrap");
  expect(execute.env?.SCRIPTC_BOOTSTRAP_SEED_DIRECTORY).toBe(
    prepare.env?.SCRIPTC_BOOTSTRAP_SEED_DIRECTORY,
  );
  // A seed is reused only for identical build inputs: both jobs name them the
  // same way, and the seed job caches the seed directory under that name.
  for (const job of [seed, checks]) {
    expect(
      job.steps.filter((step) => step.uses === "./.github/actions/bootstrap-seed-inputs"),
    ).toHaveLength(1);
  }
  const restore = seed.steps.find((step) => step.uses?.startsWith("actions/cache/restore@"))!;
  expect(restore.id).toBe("seed");
  expect(restore.with?.path).toBe("${{ runner.temp }}/native-bootstrap");
  expect(restore.with?.key).toBe("${{ steps.seed_inputs.outputs.inputs }}");
  const save = seed.steps.find((step) => step.uses?.startsWith("actions/cache/save@"))!;
  expect(save.if).toBe("steps.seed.outputs.cache-hit != 'true'");
  expect(save.with?.key).toBe("${{ steps.seed.outputs.cache-primary-key }}");
  // Two pushes can build the same seed and race to save it; losing that race
  // still leaves this run's seed for the jobs below, so it cannot fail them.
  expect(save["continue-on-error"]).toBe(true);
  // A cache hit, from this run or a push to main that shares these inputs,
  // skips the build but still archives and uploads the seed for the jobs below.
  expect(prepare.if).toBe("steps.seed.outputs.cache-hit != 'true'");
  expect(prepare.env?.SCRIPTC_BOOTSTRAP_SEED_INPUTS).toBe(
    "${{ steps.seed_inputs.outputs.inputs }}",
  );
  expect(execute.env?.SCRIPTC_BOOTSTRAP_SEED_INPUTS).toBe(
    prepare.env?.SCRIPTC_BOOTSTRAP_SEED_INPUTS,
  );
  // Runner paths are available in step contexts, not job-level env.
  for (const job of [seed, checks]) {
    expect(Object.values(job.env).some((value) => value.includes("runner."))).toBe(false);
  }
  // The actions are pinned to commits (tests/harness/ci-supply-chain.test.ts), so select them by name.
  const upload = seed.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"))!;
  const download = checks.steps.find((step) =>
    step.uses?.startsWith("actions/download-artifact@"),
  )!;
  expect(upload.with?.name).toBe("bootstrap-seed-${{ matrix.flavor }}-${{ github.sha }}");
  expect(download.with?.name).toBe(upload.with?.name);
  expect(upload.with?.["if-no-files-found"]).toBe("error");
});
