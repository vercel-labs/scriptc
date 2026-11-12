/* fs.promises.readdir's recursive Dirent walk descends on the entry's kind
 * but joins the entry's DECODED name into the path it reads (Node builds
 * that path the same way). utf8 decoding is lossy, so a raw directory name
 * can decode onto a sibling symlink's name: the directory kind then
 * authorizes the walk to read the symlink's out-of-tree target, even though
 * the Dirent walk is the no-follow form. The runtime compares the decoded
 * name with the entry's raw bytes and, when they differ, requires the joined
 * path itself to be an ordinary directory before descending. Node follows
 * the link here, so this is not a differential program. The fixture's names
 * are raw bytes, which a compiled program cannot pass to fs, so the test
 * creates them and the program only lists. */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);

const source = `import * as fsp from "node:fs/promises";

const dir: string = process.argv[2]!;
function rows(list: import("node:fs").Dirent[]): string {
  return JSON.stringify(list.map((entry) => entry.name + (entry.isDirectory() ? "/" : "")).sort());
}
console.log("promise-types", rows(await fsp.readdir(dir, { recursive: true, withFileTypes: true })));
`;

test("a promise Dirent walk does not follow a symlink named by a decoded entry name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-readdir-decoded-"));
  const outside = mkdtempSync(join(tmpdir(), "scriptc-readdir-decoded-outside-"));
  writeFileSync(join(dir, "top.txt"), "t");
  writeFileSync(join(outside, "secret.txt"), "s");
  // The raw byte 0xaf is not UTF-8; utf8 decoding turns it into U+FFFD, so
  // the directory's decoded name is the name of the sibling link below.
  const raw = Buffer.concat([Buffer.from(`${dir}/`), Buffer.from([0x6e, 0xaf])]);
  mkdirSync(raw);
  writeFileSync(Buffer.concat([raw, Buffer.from("/inside.txt")]), "i");
  symlinkSync(
    outside,
    Buffer.concat([Buffer.from(`${dir}/`), Buffer.from([0x6e, 0xef, 0xbf, 0xbd])]),
  );

  const outDir = mkdtempSync(join(tmpdir(), "scriptc-readdir-decoded-build-"));
  const entry = join(outDir, "main.ts");
  writeFileSync(entry, source);
  const result = await compile(entry, {
    backend: "llvm",
    sanitize: process.env["SCRIPTC_SAN"] === "1",
    outDir,
    outPath: join(outDir, "program"),
  });
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
  if (!result.ok) return;
  const { stdout } = await execFileAsync(result.binaryPath, [dir], { encoding: "utf8" });
  expect(stdout).toBe(`promise-types ${JSON.stringify(["n�", "n�/", "top.txt"])}\n`);
});
