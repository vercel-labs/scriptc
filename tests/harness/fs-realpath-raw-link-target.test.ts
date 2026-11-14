/* fs.realpath's plain callback form runs the walk, not realpath(3). The
 * walk must resolve the link target's RAW bytes: decoding them first is
 * lossy, and a target that decodes onto the name of another link can turn
 * an acyclic directory tree into a cycle the walk restarts forever, which
 * blocks the event loop. The fixture's `loop` link points at the byte
 * sequence 0x6e 0xaf, which exists; utf8 decoding replaces 0xaf with
 * U+FFFD, which names a second link whose own target decodes back onto
 * itself. Node's walk (which decodes, like this one used to) never
 * returns; resolving the raw target reaches the file after one
 * substitution. */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);

const source = `import * as fs from "node:fs";

const dir: string = process.argv[2]!;
fs.realpath(dir + "/loop", (error, resolved) => {
  if (error) {
    console.log("error", (error as NodeJS.ErrnoException).code);
    return;
  }
  console.log("resolved", resolved.length - dir.length, resolved.slice(dir.length));
});
`;

test("the callback realpath walk follows a link's raw target bytes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-realpath-raw-"));
  mkdirSync(join(dir, "unused"));
  // The raw byte 0xaf is not UTF-8; utf8 decoding turns it into U+FFFD.
  const raw = Buffer.concat([Buffer.from(`${dir}/`), Buffer.from([0x6e, 0xaf])]);
  writeFileSync(raw, "done");
  symlinkSync(Buffer.from([0x6e, 0xaf]), join(dir, "loop"));
  symlinkSync(
    Buffer.from([0x6e, 0xaf]),
    Buffer.concat([Buffer.from(`${dir}/`), Buffer.from([0x6e, 0xef, 0xbf, 0xbd])]),
  );

  const outDir = mkdtempSync(join(tmpdir(), "scriptc-realpath-raw-build-"));
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
  // The pre-fix walk restarts on the decoded path forever; the timeout fails
  // the test instead of hanging the suite.
  const { stdout } = await execFileAsync(result.binaryPath, [dir], {
    encoding: "buffer",
    timeout: 20_000,
  });
  expect(Buffer.from(stdout)).toEqual(
    Buffer.concat([Buffer.from("resolved 2 "), Buffer.from([0x2f, 0x6e, 0xaf]), Buffer.from("\n")]),
  );
});
