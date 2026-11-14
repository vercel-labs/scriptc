/* A recursive readdir joins its DECODED entry names into the paths it
 * descends (Node builds those paths the same way). ascii decoding masks
 * every byte with 0x7f, so a directory whose raw name is the single byte
 * 0xAE decodes to ".", and joining it onto its directory yields that same
 * directory. Node's walk has no visited check and rescans it forever; the
 * runtime remembers the paths it queued and skips a repeat, so the listing
 * of such a tree terminates. The fixture's names are raw bytes, which a
 * compiled program cannot pass to fs (a non-UTF-8 Buffer path is a named
 * refusal), so the test creates them and the program only lists. */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);

const source = `import * as fs from "node:fs";
import * as fsp from "node:fs/promises";

const dir: string = process.argv[2]!;

function shown(list: string[]): string {
  return JSON.stringify(list.map((name) => name.split(dir).join("<dir>")).sort());
}

console.log("sync", shown(fs.readdirSync(dir, { recursive: true, encoding: "ascii" })));
const syncTypes = fs.readdirSync(dir, { recursive: true, encoding: "ascii", withFileTypes: true });
console.log(
  "sync types",
  JSON.stringify(syncTypes.map((entry) => entry.name + (entry.isDirectory() ? "/" : "")).sort()),
);
console.log("promise", shown(await fsp.readdir(dir, { recursive: true, encoding: "ascii" })));
const promiseTypes = await fsp.readdir(dir, { recursive: true, encoding: "ascii", withFileTypes: true });
console.log(
  "promise types",
  JSON.stringify(promiseTypes.map((entry) => entry.name + (entry.isDirectory() ? "/" : "")).sort()),
);
`;

test("a recursive ascii listing terminates when a name decodes to a dot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-readdir-ascii-"));
  writeFileSync(join(dir, "top.txt"), "t");
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "inner.txt"), "i");
  // The directory named with the single byte 0xae decodes to ".".
  const odd = Buffer.concat([Buffer.from(`${dir}/`), Buffer.from([0xae])]);
  mkdirSync(odd);
  writeFileSync(Buffer.concat([odd, Buffer.from("/deep.txt")]), "d");

  const outDir = mkdtempSync(join(tmpdir(), "scriptc-readdir-ascii-build-"));
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
  // A walk that rescans the directory never returns; the timeout fails the
  // test on the pre-fix runtime instead of hanging the suite.
  const { stdout } = await execFileAsync(result.binaryPath, [dir], {
    encoding: "utf8",
    timeout: 20_000,
  });
  expect(stdout).toBe(
    [
      `sync ["","sub","sub/inner.txt","top.txt"]`,
      `sync types ["./","inner.txt","sub/","top.txt"]`,
      `promise ["","sub","sub/inner.txt","top.txt"]`,
      `promise types ["./","inner.txt","sub/","top.txt"]`,
      "",
    ].join("\n"),
  );
});
