import { chmod, mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { snapshotNativeArtifactDependencies } from "./artifact-stamps.js";
import { readHelperIdentityDigest, writeHelperIdentity } from "./helper-identity-record.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const DIGEST = "0".repeat(64);

async function installedHelper() {
  const root = await mkdtemp(join(tmpdir(), "scriptc-helper-record-test-"));
  dirs.push(root);
  const packageJson = join(root, "package.json");
  const binaryPath = join(root, "bin", "scriptc-llvm-codegen");
  await mkdir(join(root, "bin"));
  await writeFile(packageJson, JSON.stringify({ name: "@scriptc/llvm-test" }));
  await writeFile(binaryPath, "#!/bin/sh\nexit 0\n");
  await chmod(binaryPath, 0o755);
  const dependencies = await snapshotNativeArtifactDependencies([packageJson, binaryPath]);
  const record = join(root, ".scriptc", "identity.json");
  const read = () => readHelperIdentityDigest(packageJson, binaryPath, dependencies);
  return { root, packageJson, binaryPath, dependencies, record, read };
}

test("records the helper digest beside the installed package and reads it back", async () => {
  const helper = await installedHelper();
  await writeHelperIdentity(helper.packageJson, helper.binaryPath, DIGEST, helper.dependencies);

  expect(await helper.read()).toBe(DIGEST);
  expect(JSON.parse(await readFile(helper.record, "utf8"))).toEqual({
    version: 1,
    binary: "bin/scriptc-llvm-codegen",
    digest: DIGEST,
    dependencies: helper.dependencies,
  });
});

test("a missing record leaves the caller to hash", async () => {
  const helper = await installedHelper();
  expect(await helper.read()).toBeNull();
});

test("a changed binary invalidates the record", async () => {
  const helper = await installedHelper();
  await writeHelperIdentity(helper.packageJson, helper.binaryPath, DIGEST, helper.dependencies);
  await writeFile(helper.binaryPath, "#!/bin/sh\nexit 1\n");
  expect(await helper.read()).toBeNull();
});

test("a touched binary invalidates the record", async () => {
  const helper = await installedHelper();
  await writeHelperIdentity(helper.packageJson, helper.binaryPath, DIGEST, helper.dependencies);
  const when = new Date(2020, 0, 1);
  await utimes(helper.binaryPath, when, when);
  expect(await helper.read()).toBeNull();
});

test("a replaced binary invalidates the record", async () => {
  const helper = await installedHelper();
  await writeHelperIdentity(helper.packageJson, helper.binaryPath, DIGEST, helper.dependencies);
  const replacement = join(helper.root, "bin", "replacement");
  await writeFile(replacement, "#!/bin/sh\nexit 2\n");
  await chmod(replacement, 0o755);
  await rename(replacement, helper.binaryPath);
  expect(await helper.read()).toBeNull();
});

test("a record taken before the package metadata changed is ignored", async () => {
  const helper = await installedHelper();
  await writeHelperIdentity(helper.packageJson, helper.binaryPath, DIGEST, helper.dependencies);
  await writeFile(helper.packageJson, JSON.stringify({ name: "@scriptc/llvm-test", extra: 1 }));
  const dependencies = await snapshotNativeArtifactDependencies([
    helper.packageJson,
    helper.binaryPath,
  ]);
  expect(
    await readHelperIdentityDigest(helper.packageJson, helper.binaryPath, dependencies),
  ).toBeNull();
});

test("a corrupt or unrelated record is ignored", async () => {
  for (const text of [
    "{",
    JSON.stringify({
      version: 2,
      binary: "bin/scriptc-llvm-codegen",
      digest: DIGEST,
      dependencies: [],
    }),
    JSON.stringify({ version: 1, binary: "bin/other", digest: DIGEST, dependencies: [] }),
    JSON.stringify({
      version: 1,
      binary: "bin/scriptc-llvm-codegen",
      digest: "abc",
      dependencies: [],
    }),
  ]) {
    const helper = await installedHelper();
    await mkdir(join(helper.root, ".scriptc"), { recursive: true });
    await writeFile(helper.record, text);
    expect(await helper.read()).toBeNull();
  }
});

test("a record that cannot be written rejects so the caller can ignore it", async () => {
  const helper = await installedHelper();
  await writeFile(join(helper.root, ".scriptc"), "not a directory\n");
  await expect(
    writeHelperIdentity(helper.packageJson, helper.binaryPath, DIGEST, helper.dependencies),
  ).rejects.toBeTruthy();
});
