import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { load } from "js-yaml";
import { expect, test } from "vitest";
import { verifyBootstrapSeed } from "../../scripts/bootstrap-seed.mjs";

test("bootstrap artifacts require a complete seed from the same revision, lane, and path", () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-seed-contract-"));
  try {
    const metadata = { schema: 1, revision: "revision", sanitize: true, directory };
    writeFileSync(join(directory, "bootstrap-seed.json"), JSON.stringify(metadata));
    expect(() => verifyBootstrapSeed(directory, "revision", true)).toThrow("missing");
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
    expect(() => verifyBootstrapSeed(directory, "revision", true)).not.toThrow();
    expect(() => verifyBootstrapSeed(directory, "other", true)).toThrow("identity");
    expect(() => verifyBootstrapSeed(directory, "revision", false)).toThrow("identity");
    expect(() => verifyBootstrapSeed(directory, undefined, true)).toThrow("identity");
    writeFileSync(
      join(directory, "bootstrap-seed.json"),
      JSON.stringify({ ...metadata, directory: "/different" }),
    );
    expect(() => verifyBootstrapSeed(directory, "revision", true)).toThrow("identity");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CI restores each seed only into its matching instrumented bootstrap lane", () => {
  const workflow = load(
    readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"),
  ) as {
    jobs: Record<
      string,
      {
        needs?: string;
        strategy: { matrix: { flavor?: string[]; include?: { flavor: string }[] } };
        env: Record<string, string>;
        steps: {
          uses?: string;
          if?: string;
          with?: Record<string, unknown>;
          env?: Record<string, string>;
          run?: string;
        }[];
      }
    >;
  };
  const seed = workflow.jobs.bootstrap_seed!;
  const checks = workflow.jobs.bootstrap!;
  expect(checks.needs).toBe("bootstrap_seed");
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
  const execute = checks.steps.find((step) => step.run === "node scripts/ci-native-bootstrap.mjs")!;
  expect(prepare.env?.SCRIPTC_BOOTSTRAP_SEED_DIRECTORY).toBe("${{ runner.temp }}/native-bootstrap");
  expect(execute.env?.SCRIPTC_BOOTSTRAP_SEED_DIRECTORY).toBe(
    prepare.env?.SCRIPTC_BOOTSTRAP_SEED_DIRECTORY,
  );
  // Runner paths are available in step contexts, not job-level env.
  for (const job of [seed, checks]) {
    expect(Object.values(job.env).some((value) => value.includes("runner."))).toBe(false);
  }
  const upload = seed.steps.find((step) => step.uses === "actions/upload-artifact@v4")!;
  const download = checks.steps.find((step) => step.uses === "actions/download-artifact@v4")!;
  expect(upload.with?.name).toBe("bootstrap-seed-${{ matrix.flavor }}-${{ github.sha }}");
  expect(download.with?.name).toBe(upload.with?.name);
  expect(upload.with?.["if-no-files-found"]).toBe("error");
});
