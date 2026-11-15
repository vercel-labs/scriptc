import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { NODE_GLOBAL_NAMES } from "./node-global-names.js";

test("NODE_GLOBAL_NAMES is every name the running Node's global object answers in a module file", () => {
  // From a file: `node -e` and the REPL also define every builtin module as
  // a global, which a program run from a file never sees.
  const dir = mkdtempSync(join(tmpdir(), "scriptc-node-globals-"));
  try {
    const file = join(dir, "names.mjs");
    writeFileSync(
      file,
      [
        "const names = new Set();",
        "for (let holder = globalThis; holder !== null; holder = Object.getPrototypeOf(holder))",
        "  for (const name of Object.getOwnPropertyNames(holder)) names.add(name);",
        "console.log(JSON.stringify([...names].sort()));",
        "",
      ].join("\n"),
    );
    const names = JSON.parse(
      execFileSync(process.execPath, [file], { encoding: "utf8" }),
    ) as string[];
    expect([...NODE_GLOBAL_NAMES].sort()).toEqual(names);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the DOM's globals are not Node's", () => {
  for (const name of ["document", "window", "self", "location", "HTMLElement", "localStorage"])
    expect(NODE_GLOBAL_NAMES.has(name), name).toBe(false);
});
