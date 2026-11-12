import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { namedLinkInputDependencies } from "./link-inputs.js";

const roots: string[] = [];

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "scriptc-link-inputs-"));
  roots.push(root);
  return root;
}

function file(root: string, name: string, contents: string = ""): string {
  const path = join(root, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A thin archive the host's `ar` can write: the format records member paths
 * and stores no member content. */
function thinArchiveSupported(): boolean {
  try {
    const root = scratch();
    file(root, "member.o", "member\n");
    execFileSync("ar", ["crsT", join(root, "probe.a"), "member.o"], {
      cwd: root,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

const THIN_ARCHIVE = thinArchiveSupported();

test("a linker script names the scripts it includes and the inputs it adds", async () => {
  const root = scratch();
  const absObject = file(root, "objects/abs.o");
  const needed = file(root, "objects/needed.so");
  const sibling = file(root, "objects/sibling.o");
  const relative = file(root, "relative.o");
  const included = file(root, "nested/inner.ld", `INPUT ( ${sibling} )\n`);
  const script = file(
    root,
    "main.ld",
    [
      "/* A comment naming a file that is not an input: missing.o */",
      'INCLUDE "nested/inner.ld"',
      `INPUT( ${absObject} relative.o )`,
      "SECTIONS { .text : { *(.text) *(.rodata) } }",
      `GROUP ( relative.o AS_NEEDED ( ${needed} ) )`,
      "",
    ].join("\n"),
  );

  expect(await namedLinkInputDependencies([script], { cwd: root })).toEqual(
    [absObject, included, needed, sibling, relative].sort(),
  );
});

test("every list in a script names its files", async () => {
  const root = scratch();
  const first = file(root, "first.o");
  const second = file(root, "second.o");
  const third = file(root, "third.o");
  const script = file(
    root,
    "script.ld",
    `INPUT ( ${first} ) GROUP ( ${second} ) STARTUP ( ${third} )\n`,
  );

  expect(await namedLinkInputDependencies([script], { cwd: root })).toEqual(
    [first, second, third].sort(),
  );
});

test("SEARCH_DIR and -l names resolve to the files they select", async () => {
  const root = scratch();
  const library = file(root, "lib/libfoo.so");
  const searched = file(root, "lib/libsearch.a");
  const script = file(
    root,
    "inputs/link.ld",
    [
      "SEARCH_DIR( ../lib )",
      "INPUT ( -lfoo -l:libfoo.so -lsearch )",
      "GROUP ( -lmissing )",
      "",
    ].join("\n"),
  );

  expect(await namedLinkInputDependencies([script], { cwd: root })).toEqual(
    [library, searched].sort(),
  );
});

test.skipIf(!THIN_ARCHIVE)("a thin archive names its external members", async () => {
  const root = scratch();
  const member = file(root, "members/member.o", "member\n");
  const second = file(root, "other/second.o", "second\n");
  const archive = join(root, "libthin.a");
  execFileSync("ar", ["crsT", archive, "members/member.o", second], { cwd: root, stdio: "ignore" });
  const elsewhere = scratch();

  expect(await namedLinkInputDependencies([archive], { cwd: elsewhere })).toEqual(
    [member, second].sort(),
  );
});

test("a regular archive and an object file name nothing", async () => {
  const root = scratch();
  const member = file(root, "member.o", "member\n");
  const archive = join(root, "libplain.a");
  execFileSync("ar", ["crs", archive, member], { cwd: root, stdio: "ignore" });
  const object = file(root, "object.o", "\x7fELF\u0002\u0001\u0001\u0000");

  expect(await namedLinkInputDependencies([archive, object], { cwd: root })).toEqual([]);
});

test("names that do not exist are left out", async () => {
  const root = scratch();
  const existing = file(root, "existing.o");
  const script = file(
    root,
    "script.ld",
    ['INCLUDE "missing.ld"', "INPUT ( missing.o existing.o )", ""].join("\n"),
  );

  expect(await namedLinkInputDependencies([script], { cwd: root })).toEqual([existing]);
});

test("a file under an excluded root is not recorded", async () => {
  const root = scratch();
  const staged = join(root, "staged");
  const owned = file(staged, "owned.o");
  const other = file(root, "other.o");
  const script = file(root, "script.ld", `INPUT ( ${owned} ${other} )\n`);

  expect(
    await namedLinkInputDependencies([script], { cwd: root, excludedRoots: [staged] }),
  ).toEqual([other]);
});

test("naming more files than allowed keeps the proof unpublished", async () => {
  const root = scratch();
  const first = file(root, "first.o");
  const second = file(root, "second.o");
  const script = file(root, "script.ld", `INPUT ( ${first} ${second} )\n`);

  await expect(namedLinkInputDependencies([script], { cwd: root, maxFiles: 1 })).rejects.toThrow(
    /names more than 1 files/,
  );
});
