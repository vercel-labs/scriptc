/* The suggested `scriptc types patch` command on a checked-conversion
 * TypeError (scr_type_origin.c) passes each value it carries as one
 * argument: package names and selectors come from package declarations,
 * and a command copied from the message must not run anything they spell.
 * Run through sh with printf in place of scriptc, the command prints the
 * package, the selector and the type exactly, and creates no file. */
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { EXECUTABLE_RUNTIME_SOURCES } from "../../compiler/src/backend/native-toolchain.js";

const exec = promisify(execFile);

const hostile = [
  ["kit", "Profile.email"],
  ["evil;touch pkg", "Profile.a;touch semicolon"],
  ["kit", "Profile.$(touch subst)"],
  ["kit", "Profile.`touch backtick`"],
  ["kit", "Profile.it's \"quoted\" \\ end'"],
  ["kit", "Profile.a&&touch and|touch pipe>out"],
] as const;

test.skipIf(process.platform === "win32")(
  "the suggested patch command passes declaration values as single arguments",
  { timeout: 300_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-type-origin-"));
    try {
      const bin = join(dir, "origin");
      await exec("clang", [
        "-std=c11",
        "-O1",
        "-w",
        "-pthread",
        ...(process.platform === "linux" ? ["-D_GNU_SOURCE"] : []),
        join(import.meta.dirname, "scr_type_origin.test.c"),
        join(import.meta.dirname, "scr_type_origin.c"),
        ...EXECUTABLE_RUNTIME_SOURCES.map((name) => join(import.meta.dirname, name)),
        ...(process.platform === "linux" ? ["-lm"] : []),
        "-o",
        bin,
      ]);
      const sandbox = join(dir, "run");
      await exec("mkdir", [sandbox]);
      const commands: string[] = [];
      for (const [pkg, selector] of hostile) {
        const { stdout } = await exec(bin, [pkg, selector]);
        const line = stdout.split("\n").find((l) => l.includes("scriptc types patch"));
        expect(line, stdout).toBeDefined();
        const command = line!.slice(line!.indexOf("scriptc types patch"));
        commands.push(command);
        const printed = await exec(
          "sh",
          ["-c", command.replace("scriptc types patch", "printf '%s\\n'")],
          { cwd: sandbox },
        );
        expect(printed.stdout).toBe(`${pkg}\n${selector}\n| undefined\n`);
        expect(await readdir(sandbox)).toEqual([]);
      }
      // Values without shell syntax stay bare.
      expect(commands[0]).toBe("scriptc types patch kit Profile.email '| undefined'");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
