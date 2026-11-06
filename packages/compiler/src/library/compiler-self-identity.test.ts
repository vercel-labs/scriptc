import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import {
  compilerImplementationDependenciesStillMatch,
  compilerImplementationIdentity,
} from "./compiler-self-identity.js";

const scratch: string[] = [];

const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  // The identity names the directory it scanned, so fixtures are canonical:
  // a temporary directory can sit behind a symlink (as /tmp does on macOS).
  const root = await realpath(
    await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-self-identity-")),
  );
  scratch.push(root);
  return root;
}

async function recordedDigest(root: string): Promise<string> {
  const record = JSON.parse(
    await readFile(join(root, ".scriptc", "install-digest.json"), "utf8"),
  ) as { version: number; digest: string };
  expect(record.version).toBe(1);
  return record.digest;
}

test("parallel fingerprinting preserves the v1 byte stream and dependency order across batches", async () => {
  const root = await fixture();
  await mkdir(join(root, "a"));
  await mkdir(join(root, "z"));
  // Sorted depth-first order is deliberately DIFFERENT from sorting the
  // complete paths (a.ts would precede a/index.ts). More than one batch,
  // empty files, and differently sized reads exercise ordered hashing.
  const files: [string, string][] = [
    [join("a", "index.ts"), "export const value = 42;\n"],
    ["a.ts", ""],
    ...Array.from({ length: 140 }, (_, i): [string, string] => [
      join("z", `file${String(i).padStart(3, "0")}.js`),
      `// ${i}\n${"\u03bb".repeat(i * 1000)}`,
    ]),
  ];
  await Promise.all([...files].reverse().map(([path, text]) => writeFile(join(root, path), text)));
  const expected = createHash("sha256").update("scriptc-frontend-implementation-v1\0");
  for (const [path, text] of files) expected.update(path).update("\0").update(text).update("\0");
  const first = await compilerImplementationIdentity(true, root);
  expect(first.digest).toBe(expected.digest("hex"));
  expect(first.dependencies.map((item) => relative(root, item.path))).toEqual([
    "",
    "a",
    join("a", "index.ts"),
    "a.ts",
    "z",
    ...files.slice(2).map(([path]) => path),
  ]);
  expect(await compilerImplementationDependenciesStillMatch(first.dependencies)).toBe(true);
  const withoutProof = await compilerImplementationIdentity(false, root);
  expect(withoutProof).toEqual({ digest: first.digest, dependencies: [] });
});

test("content edits, including same-size writes, change the fingerprint and invalidate its proof", async () => {
  const root = await fixture();
  const source = join(root, "compiler.js");
  await writeFile(source, "one");
  const before = await compilerImplementationIdentity(true, root);
  await writeFile(source, "two");
  // Avoid depending on a filesystem's timestamp resolution for this test.
  await utimes(source, new Date(1_000), new Date(1_000));
  expect(await compilerImplementationDependenciesStillMatch(before.dependencies)).toBe(false);
  const after = await compilerImplementationIdentity(true, root);
  expect(after.digest).not.toBe(before.digest);
  expect(await compilerImplementationDependenciesStillMatch(after.dependencies)).toBe(true);
});

test("added, renamed, and removed compiler files invalidate the captured directory proof", async () => {
  const root = await fixture();
  const directory = join(root, "nested");
  await mkdir(directory);
  await writeFile(join(directory, "first.js"), "unchanged");
  const original = await compilerImplementationIdentity(true, root);
  await writeFile(join(directory, "second.js"), "new");
  await utimes(directory, new Date(1_000), new Date(1_000));
  expect(await compilerImplementationDependenciesStillMatch(original.dependencies)).toBe(false);
  const added = await compilerImplementationIdentity(true, root);
  expect(added.digest).not.toBe(original.digest);
  await rename(join(directory, "second.js"), join(directory, "renamed.js"));
  expect(await compilerImplementationDependenciesStillMatch(added.dependencies)).toBe(false);
  const renamed = await compilerImplementationIdentity(true, root);
  expect(renamed.digest).not.toBe(added.digest);
  await rm(join(directory, "renamed.js"));
  expect(await compilerImplementationDependenciesStillMatch(renamed.dependencies)).toBe(false);
  expect((await compilerImplementationIdentity(true, root)).digest).toBe(original.digest);
});

test.skipIf(process.platform === "win32")(
  "symlinked dependencies remain outside the compiler package fingerprint",
  async () => {
    const root = await fixture();
    const external = await fixture();
    await writeFile(join(root, "index.js"), "compiler");
    await writeFile(join(external, "index.js"), "dependency");
    await symlink(external, join(root, "dependency"));
    await symlink(root, join(root, "cycle"));
    const before = await compilerImplementationIdentity(true, root);
    expect(before.dependencies.map((item) => relative(root, item.path))).toEqual(["", "index.js"]);
    await writeFile(join(external, "index.js"), "changed dependency");
    expect((await compilerImplementationIdentity(true, root)).digest).toBe(before.digest);
    expect(await compilerImplementationDependenciesStillMatch(before.dependencies)).toBe(true);
  },
);

test("missing compiler roots fail instead of producing a usable identity", async () => {
  const root = await fixture();
  const missing = join(root, "missing");
  await expect(compilerImplementationIdentity(true, missing)).rejects.toMatchObject({
    code: "ENOENT",
  });
  // Recording a digest must not bring a missing package root into existence.
  await expect(stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
});

test("an unchanged install reuses the digest it recorded", async () => {
  const root = await fixture();
  await writeFile(join(root, "compiler.js"), "one");
  const first = await compilerImplementationIdentity(true, root);
  expect(await recordedDigest(root)).toBe(first.digest);
  const record = join(root, ".scriptc", "install-digest.json");
  await utimes(record, new Date(1_000), new Date(1_000));
  const again = await compilerImplementationIdentity(true, root);
  expect(again).toEqual(first);
  // A reused digest leaves the record untouched; a recomputed one rewrites it.
  expect((await stat(record)).mtimeMs).toBe(1_000);
});

test("a modified installed package is detected", async () => {
  const root = await fixture();
  const source = join(root, "compiler.js");
  await writeFile(source, "one");
  const before = await compilerImplementationIdentity(true, root);
  await writeFile(source, "two");
  await utimes(source, new Date(1_000), new Date(1_000));
  const after = await compilerImplementationIdentity(true, root);
  expect(after.digest).not.toBe(before.digest);
  expect(await recordedDigest(root)).toBe(after.digest);
  // The refreshed record describes the package as it is now.
  expect(await compilerImplementationDependenciesStillMatch(after.dependencies)).toBe(true);
});

test("an install that cannot store its digest still hashes its files", async () => {
  const root = await fixture();
  await writeFile(join(root, "compiler.js"), "one");
  // A file in place of the record directory makes the write fail.
  await writeFile(join(root, ".scriptc"), "not a directory");
  const first = await compilerImplementationIdentity(true, root);
  const second = await compilerImplementationIdentity(true, root);
  expect(second.digest).toBe(first.digest);
  expect(first.dependencies.map((item) => relative(root, item.path))).toEqual([
    "",
    ".scriptc",
    "compiler.js",
  ]);
});

test("a copied installation does not reuse the original's record", async () => {
  const root = await fixture();
  const holder = await fixture();
  await writeFile(join(root, "compiler.js"), "one");
  const original = await compilerImplementationIdentity(true, root);
  // The copy carries the original's record, whose dependencies name the
  // original's files. Those are still present and still match there.
  const copied = join(holder, "package");
  await cp(root, copied, { recursive: true });
  await writeFile(join(copied, "compiler.js"), "two");
  const after = await compilerImplementationIdentity(true, copied);
  expect(after.digest).not.toBe(original.digest);
  expect(await recordedDigest(copied)).toBe(after.digest);
  const record = JSON.parse(
    await readFile(join(copied, ".scriptc", "install-digest.json"), "utf8"),
  ) as { root: string };
  expect(record.root).toBe(await realpath(copied));
});

test.skipIf(process.platform === "win32")(
  "a symlinked package path fingerprints the package it names",
  async () => {
    const root = await fixture();
    await writeFile(join(root, "compiler.js"), "one");
    const link = `${root}-link`;
    scratch.push(link);
    await symlink(root, link);
    // The link is not one of the kinds the walk records, so a cache miss has
    // to scan the directory it names instead of treating it as a file.
    const linked = await compilerImplementationIdentity(true, link);
    expect(linked.dependencies.map((item) => relative(root, item.path))).toEqual([
      "",
      "compiler.js",
    ]);
    expect((await compilerImplementationIdentity(true, root)).digest).toBe(linked.digest);
    expect(await recordedDigest(link)).toBe(linked.digest);
  },
);

test.skipIf(process.platform === "win32")(
  "a retargeted package link names the install it points at",
  async () => {
    const holder = await fixture();
    // `--preserve-symlinks` keeps the spelling that reached a module in its
    // URL, so a package reached through a link reports the link as its root.
    // The root a proof is written for has to be the directory the link names:
    // retargeting the link selects another compiler, and a proof that still
    // names the old root would keep replaying the old digest.
    const built = await readFile(
      join(import.meta.dirname, "../../dist/library/compiler-self-identity.js"),
      "utf8",
    );
    const firstInstall = join(holder, "one");
    const secondInstall = join(holder, "two");
    for (const install of [firstInstall, secondInstall]) {
      await mkdir(join(install, "dist", "library"), { recursive: true });
      await writeFile(
        join(install, "package.json"),
        JSON.stringify({ name: "@scriptc/compiler", type: "module" }),
      );
      await writeFile(join(install, "dist", "library", "compiler-self-identity.js"), built);
    }
    await writeFile(join(secondInstall, "dist", "marker.txt"), "two\n");
    const link = join(holder, "live");
    await symlink(firstInstall, link);
    const proofPath = join(holder, "proof.json");
    const probe = join(holder, "probe.mjs");
    // The same replay check `coverageCompilerIdentity` makes: a proof replays
    // only while the root it names is the current one and its files match.
    await writeFile(
      probe,
      [
        "import { pathToFileURL } from 'node:url';",
        "import { readFile, writeFile } from 'node:fs/promises';",
        "const [link, proofPath] = process.argv.slice(2);",
        "const module = await import(",
        "  pathToFileURL(link + '/dist/library/compiler-self-identity.js').href,",
        ");",
        "const root = module.compilerImplementationRoot();",
        "const identity = await module.compilerImplementationIdentity(true);",
        "let replayed = null;",
        "try {",
        "  const proof = JSON.parse(await readFile(proofPath, 'utf8'));",
        "  const matches = await module.compilerImplementationDependenciesStillMatch(",
        "    proof.dependencies,",
        "  );",
        "  if (proof.root === root && matches) replayed = proof.digest;",
        "} catch {",
        "  // No proof yet.",
        "}",
        "if (replayed === null)",
        "  await writeFile(",
        "    proofPath,",
        "    JSON.stringify({ root, digest: identity.digest, dependencies: identity.dependencies }),",
        "  );",
        "console.log(JSON.stringify({ root, digest: identity.digest, replayed }));",
        "",
      ].join("\n"),
    );
    const record = async (): Promise<{ root: string; digest: string; replayed: string | null }> => {
      const { stdout } = await execFileAsync(
        process.execPath,
        ["--preserve-symlinks", probe, link, proofPath],
        { encoding: "utf8" },
      );
      return JSON.parse(stdout);
    };

    const before = await record();
    expect(before.root).toBe(await realpath(firstInstall));
    expect(before.replayed).toBeNull();

    await rm(link, { force: true });
    await symlink(secondInstall, link);
    const after = await record();
    expect(after.root).toBe(await realpath(secondInstall));
    expect(after.replayed).toBeNull();
    expect(after.digest).not.toBe(before.digest);
  },
  60_000,
);
