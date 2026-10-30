/* Strings that come from bytes the OS hands over (directory entry names,
 * command-line arguments) decode as UTF-8 with U+FFFD for each malformed
 * subsequence, as Node decodes them, and a word segmenter over them matches
 * Node: overlong forms, truncated sequences, stray continuation bytes and
 * UTF-8-encoded surrogates included. readdir also lists those names in Node's
 * raw byte order, which decoding can reorder. */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);

const PROGRAM = `
import { readdirSync } from "node:fs";
const words = new Intl.Segmenter(undefined, { granularity: "word" });
function show(label: string, text: string): void {
  const parts = [...words.segment(text)].map((part) => JSON.stringify(part.segment) + "@" + part.index);
  console.log(label, JSON.stringify(text), text.length, parts.join(" "));
}
const names = readdirSync(process.argv[2]!);
for (const name of names) show("order", name);
for (const name of names.sort()) show("name", name);
show("arg", process.argv[3]!);
`;

const NAMES = [
  [0x61, 0xff, 0x62, 0x2e, 0x74, 0x78, 0x74],
  [0x6f, 0x76, 0x65, 0x72, 0xf0, 0x80, 0x80, 0x41, 0x6c, 0x6f, 0x6e, 0x67],
  [0x74, 0x72, 0x75, 0x6e, 0x63, 0xe2, 0x82],
  [0x73, 0x75, 0x72, 0xed, 0xa0, 0x80, 0x78],
  [0x6f, 0x6b, 0x2d, 0xc3, 0xa9, 0x2e, 0x74, 0x78, 0x74],
  [0x63, 0x6f, 0x6e, 0x74, 0x80, 0xbf, 0x20, 0x77, 0x6f, 0x72, 0x64],
  /* Names whose raw bytes and decoded text order differently: the malformed
   * lead byte 0x80 sorts before "é" as bytes but decodes to U+FFFD, which
   * sorts after it, and 0xfe decodes to the same text as 0x80. Node lists
   * them in raw byte order. */
  [0x80, 0x61],
  [0xc3, 0xa9],
  [0xfe, 0x61],
];

test.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "malformed UTF-8 from directory entries and arguments segments as in Node",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "scriptc-intl-malformed-"));
    try {
      const entry = join(dir, "main.ts");
      writeFileSync(entry, PROGRAM);
      const files = join(dir, "files");
      mkdirSync(files);
      for (const name of NAMES)
        writeFileSync(Buffer.concat([Buffer.from(files + "/"), Buffer.from(name)]), "");
      const result = await compile(entry, {
        outPath: join(dir, "out", "main"),
        outDir: join(dir, "out"),
        sanitize: process.env["SCRIPTC_SAN"] === "1",
      });
      expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
      if (!result.ok) return;
      // The argument's bytes are not valid UTF-8, so the shell passes them.
      const run = (argv0: string[]) =>
        execFileAsync(
          "/bin/sh",
          ["-c", `"$@" "$(printf 'go\\377\\340\\200wo rd')"`, "sh", ...argv0, files],
          {
            env: { ...process.env, LC_ALL: "en_US.UTF-8" },
          },
        );
      const node = await run([process.execPath, entry]);
      const native = await run([result.binaryPath]);
      expect(native.stdout).toBe(node.stdout);
      expect(node.stdout).toContain("�");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  300_000,
);
