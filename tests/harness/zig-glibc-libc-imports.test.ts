/* glibc executables linked with zig take memset, memcpy, memcmp and bcmp
 * from libc. zig's compiler-rt is one object that also defines those
 * functions: a reference to any builtin only it provides (__udivti3, say)
 * links the whole object, and its definitions then take precedence over
 * libc's for the entire program. The runtime references none of those
 * builtins, so the executable imports the four functions and defines none
 * of them. */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const hasZig = spawnSync("zig", ["version"], { stdio: "ignore" }).status === 0;
const linuxX64 = process.platform === "linux" && process.arch === "x64";
const LIBC_FUNCTIONS = ["memset", "memcpy", "memcmp", "bcmp"];

// BigInt division by one limb reaches the reciprocal that used to call
// __udivti3; the string, array and Map operations reach the four functions.
const SOURCE = `const big = 10n ** 40n + 12345n;
console.log((big / 97n).toString(), (big % 1000003n).toString());
const words = ["delta", "alpha", "charlie", "bravo", "alpha"];
words.sort();
console.log(words.join(","), words[0] === words[1], "abc".localeCompare("abd"));
const counts = new Map<string, number>();
for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
console.log([...counts].map(([k, v]) => k + "=" + v).join(" "));
const filled = new Array<number>(64).fill(7);
const copied = filled.slice(8, 40);
console.log(copied.length, copied.reduce((a, b) => a + b, 0));
`;

function symbols(args: string[], binary: string): string[] {
  return execFileSync("nm", [...args, binary], { encoding: "utf8" }).split("\n");
}

test.for(["release", "speed"] as const)(
  "a zigcc glibc %s build imports memset, memcpy, memcmp and bcmp from libc",
  { timeout: 600_000 },
  async (optimization, context) => {
    if (!hasZig || !linuxX64) context.skip();
    const dir = await mkdtemp("/tmp/scriptc-zig-glibc-");
    const previousTarget = process.env["SCRIPTC_TARGET"];
    const previousCc = process.env["SCRIPTC_CC"];
    try {
      const entry = join(dir, "main.ts");
      await writeFile(entry, SOURCE);
      process.env["SCRIPTC_TARGET"] = "x86_64-linux-gnu.2.34";
      process.env["SCRIPTC_CC"] = "zigcc";
      const result = await compile(entry, {
        outDir: dir,
        outPath: join(dir, "main"),
        backend: "llvm",
        optimization,
      });
      if (!result.ok)
        throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));

      const imported = symbols(["-D", "--undefined-only"], result.binaryPath);
      const defined = symbols(["--defined-only"], result.binaryPath);
      for (const name of LIBC_FUNCTIONS) {
        const imports = imported.some((line) => new RegExp(`\\bU ${name}@GLIBC_`).test(line));
        expect(imports, `${name} is imported from glibc`).toBe(true);
        expect(
          defined.filter((line) => line.endsWith(` ${name}`)),
          `${name} has no definition in the executable`,
        ).toEqual([]);
      }

      const native = spawnSync(result.binaryPath, [], { encoding: "utf8" });
      const node = spawnSync(process.execPath, ["--no-warnings", entry], { encoding: "utf8" });
      expect(node.status).toBe(0);
      expect({ status: native.status, stdout: native.stdout }).toEqual({
        status: 0,
        stdout: node.stdout,
      });
    } finally {
      if (previousTarget === undefined) delete process.env["SCRIPTC_TARGET"];
      else process.env["SCRIPTC_TARGET"] = previousTarget;
      if (previousCc === undefined) delete process.env["SCRIPTC_CC"];
      else process.env["SCRIPTC_CC"] = previousCc;
      await rm(dir, { recursive: true, force: true });
    }
  },
);
