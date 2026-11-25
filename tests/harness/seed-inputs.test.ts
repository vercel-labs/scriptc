import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { seedInputFiles, seedInputHashes } from "../../scripts/seed-inputs.mjs";

test("the seed identity follows the build entry points' import graph", () => {
  const files = seedInputFiles();
  // The seed runs build-native-cli, which imports its profile helper and the staging script; the staging script
  // imports the bundling helper. None of these may fall out of the identity when their imports change.
  for (const path of [
    "scripts/bootstrap-seed.mjs",
    "scripts/build-native-cli.mts",
    "scripts/build-native-cli-profile.mjs",
    "scripts/native-cli-assets.mts",
    "scripts/native-cli-bundle.mjs",
  ])
    expect(files, path).toContain(path);
  for (const path of files)
    expect(path.startsWith("scripts/") || path.startsWith("native/")).toBe(true);
  const hashes = seedInputHashes();
  expect(Object.keys(hashes).sort()).toEqual(files);
  for (const hash of Object.values(hashes)) expect(hash).toMatch(/^[0-9a-f]{64}$/);
});

test("a new relative import is part of the identity without a hand list", () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-seed-inputs-"));
  try {
    mkdirSync(join(directory, "scripts"));
    mkdirSync(join(directory, "native"));
    writeFileSync(
      join(directory, "scripts/entry.mjs"),
      'import { helper } from "./helper.js";\nimport "node:fs";\nimport "some-package";\n',
    );
    writeFileSync(
      join(directory, "scripts/helper.ts"),
      'import { staging } from "../native/staging.js";\nexport const helper = staging;\n',
    );
    writeFileSync(join(directory, "native/staging.mts"), "export const staging = 1;\n");
    expect(seedInputFiles(directory, ["scripts/entry.mjs"])).toEqual([
      "native/staging.mts",
      "scripts/entry.mjs",
      "scripts/helper.ts",
    ]);
    const before = seedInputHashes(directory, ["scripts/entry.mjs"]);
    writeFileSync(join(directory, "native/staging.mts"), "export const staging = 2;\n");
    const after = seedInputHashes(directory, ["scripts/entry.mjs"]);
    expect(after["native/staging.mts"]).not.toBe(before["native/staging.mts"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
