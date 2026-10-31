/* The suggested `scriptc types patch` command in a declared-type note
 * (frontend/lowering/decl-origin.ts) passes each value it carries as one
 * argument. Package names, selectors and types come from package
 * declarations. Run through sh with printf in place of scriptc, the POSIX
 * form prints each value exactly and creates no file. The Windows form
 * double-quotes values that cmd and PowerShell keep as written there, and
 * leaves the arguments out when either shell would expand or escape one. */
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { patchSuggestion, shellArgument } from "../src/frontend/lowering/decl-origin.js";

const exec = promisify(execFile);

const hostile = [
  "Profile.a;touch semicolon",
  "Profile.$(touch subst)",
  "Profile.`touch backtick`",
  "Profile.it's \"quoted\" \\ end'",
  "Profile.a&&touch and|touch pipe>out",
  "Profile.a\nb",
];

test("plain values stay bare and types are quoted", () => {
  expect(patchSuggestion("kit", "Profile.email", "| undefined", false)).toBe(
    "if that declaration is wrong, patch it: scriptc types patch kit Profile.email '| undefined'",
  );
  expect(patchSuggestion("@scope/kit", "Terminal.columns()", "| undefined", true)).toBe(
    'if that declaration is wrong, patch it: scriptc types patch @scope/kit "Terminal.columns()" "| undefined"',
  );
});

test.skipIf(process.platform === "win32")(
  "the POSIX form passes each value as one argument",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-decl-origin-"));
    try {
      for (const selector of hostile) {
        const pkg = "evil;touch pkg";
        const command = patchSuggestion(pkg, selector, "| undefined", false).replace(
          "if that declaration is wrong, patch it: scriptc types patch",
          "printf '%s\\n'",
        );
        const { stdout } = await exec("sh", ["-c", command], { cwd: dir });
        expect(stdout).toBe(`${pkg}\n${selector}\n| undefined\n`);
        expect(await readdir(dir)).toEqual([]);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("the Windows form double-quotes values only where both shells keep them", () => {
  expect(shellArgument("Profile.a;b&c|d<e>f", true)).toBe('"Profile.a;b&c|d<e>f"');
  for (const value of [
    "Profile.$(x)",
    "Profile.`x`",
    'Profile."x"',
    "Profile.%PATH%",
    "Profile.!x!",
    "Profile.“x”",
    "Profile.‘x’",
    "Profile.a\nb",
  ])
    expect(shellArgument(value, true), value).toBeNull();
  expect(patchSuggestion("kit", "Profile.$(x)", "| undefined", true)).toBe(
    "if that declaration is wrong, patch it with scriptc types patch",
  );
});
