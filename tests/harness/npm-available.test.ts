import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expect, test } from "vitest";

const repoRoot = join(import.meta.dirname, "../..");
const script = join(repoRoot, "scripts", "wait-npm-available.mjs");

// A stand-in for `npm view <spec> version`: each spec resolves on the check
// numbered in registry.json (0 never resolves). Every call is logged.
const fakeNpm = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const dir = process.env.FAKE_NPM_DIR;
const args = process.argv.slice(2);
appendFileSync(join(dir, "calls.log"), JSON.stringify(args) + "\\n");
const spec = args[1];
const calls = readFileSync(join(dir, "calls.log"), "utf8").trim().split("\\n")
  .filter((line) => JSON.parse(line)[1] === spec).length;
const registry = JSON.parse(readFileSync(join(dir, "registry.json"), "utf8"));
const resolvesOn = registry[spec];
if (resolvesOn === undefined) {
  process.stderr.write("npm error code E404\\n");
  process.exit(1);
}
if (resolvesOn !== 0 && calls >= resolvesOn) {
  process.stdout.write(spec.slice(spec.lastIndexOf("@") + 1) + "\\n");
}
`;

function run(uploads: string, registry: Record<string, number>, extra: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-npm-available-"));
  try {
    writeFileSync(join(dir, "npm"), fakeNpm);
    chmodSync(join(dir, "npm"), 0o755);
    writeFileSync(join(dir, "registry.json"), JSON.stringify(registry));
    writeFileSync(join(dir, "calls.log"), "");
    writeFileSync(join(dir, "uploads.txt"), uploads);
    writeFileSync(join(dir, "summary.md"), "");
    const result = spawnSync(process.execPath, [script, join(dir, "uploads.txt"), ...extra], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}${delimiter}${process.env["PATH"] ?? ""}`,
        FAKE_NPM_DIR: dir,
        GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
      },
    });
    const calls = readFileSync(join(dir, "calls.log"), "utf8")
      .trim()
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as string[]);
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      calls,
      summary: readFileSync(join(dir, "summary.md"), "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test.skipIf(process.platform === "win32")(
  "waits until every package resolves and reports each package's time from upload",
  () => {
    const accepted = Math.floor(Date.now() / 1000) - 90;
    const result = run(
      `@scriptc/runtime@1.2.3 ${accepted}\nscriptc@1.2.3\n`,
      { "@scriptc/runtime@1.2.3": 1, "scriptc@1.2.3": 3 },
      ["--interval", "0.05", "--timeout", "30"],
    );
    expect(result.status, result.output).toBe(0);
    expect(result.output).toMatch(/@scriptc\/runtime@1\.2\.3 is available \(1m 3\ds\)/);
    expect(result.output).toContain("scriptc@1.2.3 is available (upload time not recorded)");
    expect(result.output).toContain("Every package resolves on npm (2).");
    // A package that resolved is not asked again.
    expect(result.calls.filter((args) => args[1] === "@scriptc/runtime@1.2.3")).toHaveLength(1);
    expect(result.calls.filter((args) => args[1] === "scriptc@1.2.3")).toHaveLength(3);
    for (const args of result.calls)
      expect(args).toEqual(["view", args[1], "version", "--prefer-online"]);
    expect(result.summary).toContain("| `scriptc@1.2.3` | upload time not recorded |");
  },
);

test.skipIf(process.platform === "win32")(
  "fails with the names and versions of the packages that do not resolve by the timeout",
  () => {
    const result = run(
      "@scriptc/runtime@1.2.3\n@scriptc/compiler@1.2.3\nscriptc@1.2.3\n",
      { "@scriptc/runtime@1.2.3": 1, "@scriptc/compiler@1.2.3": 0 },
      ["--interval", "0.1", "--timeout", "0.5"],
    );
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain("2 of 3 packages do not resolve on npm after");
    expect(result.output).toContain("::error::@scriptc/compiler@1.2.3 does not resolve on npm");
    expect(result.output).toContain("::error::scriptc@1.2.3 does not resolve on npm");
    expect(result.output).not.toContain("::error::@scriptc/runtime@1.2.3");
    expect(
      result.calls.filter((args) => args[1] === "@scriptc/compiler@1.2.3").length,
    ).toBeGreaterThan(1);
    expect(result.summary).toContain("| `@scriptc/compiler@1.2.3` | missing |");
    expect(result.summary).toContain("| `scriptc@1.2.3` | missing |");
  },
);

test("rejects a malformed uploads file", () => {
  const result = run("scriptc 1.2.3\n", {}, []);
  expect(result.status).toBe(1);
  expect(result.output).toContain("malformed upload line: scriptc 1.2.3");
  expect(result.calls).toHaveLength(0);
});
