import { expect, test } from "vitest";
import { programArgumentsStart, USAGE } from "./usage.js";

/** scriptc's own arguments and the program's, as `scriptc run` splits them. */
function split(args: string[]): [string[], string[]] {
  const start = programArgumentsStart(args);
  return [args.slice(0, start), args.slice(start)];
}

test("everything after the entry file of run is the program's, as with node", () => {
  expect(split(["run", "main.ts", "a", "b"])).toEqual([
    ["run", "main.ts"],
    ["a", "b"],
  ]);
  // Options and a `--` after the entry reach the program as written.
  expect(split(["run", "main.ts", "--strip", "-o", "x", "--", "c"])).toEqual([
    ["run", "main.ts"],
    ["--strip", "-o", "x", "--", "c"],
  ]);
  expect(split(["run", "main.ts", "--", "a", "--flag"])).toEqual([
    ["run", "main.ts"],
    ["--", "a", "--flag"],
  ]);
  expect(split(["run", "main.ts"])).toEqual([["run", "main.ts"], []]);
});

test("scriptc's options come before the entry, and their values are not the entry", () => {
  expect(split(["run", "--strip", "-o", "out", "--optimization", "dev", "main.ts", "a"])).toEqual([
    ["run", "--strip", "-o", "out", "--optimization", "dev", "main.ts"],
    ["a"],
  ]);
  expect(
    split(["--sanitize", "run", "--out=bin", "-oout", "--no-keep-llvm", "main.ts", "-h"]),
  ).toEqual([["--sanitize", "run", "--out=bin", "-oout", "--no-keep-llvm", "main.ts"], ["-h"]]);
  // A group of short options that ends in one with a value takes the next argument.
  expect(split(["run", "-ho", "out", "main.ts", "a"])).toEqual([
    ["run", "-ho", "out", "main.ts"],
    ["a"],
  ]);
  // An unknown option takes no value; the parser reports it from the left part.
  expect(split(["run", "--optimisation", "dev", "main.ts"])).toEqual([
    ["run", "--optimisation", "dev"],
    ["main.ts"],
  ]);
});

test("-- before the entry ends scriptc's options", () => {
  expect(split(["run", "--strip", "--", "-entry.ts", "--strip"])).toEqual([
    ["run", "--strip", "--", "-entry.ts"],
    ["--strip"],
  ]);
  expect(split(["run", "--", "main.ts", "--", "a"])).toEqual([
    ["run", "--", "main.ts"],
    ["--", "a"],
  ]);
});

test("only run has program arguments", () => {
  for (const args of [
    ["build", "main.ts", "--strip", "extra"],
    ["coverage", "main.ts", "--", "a"],
    ["types", "patch", "pkg", "Selector.member", "| undefined"],
    ["merge-profiles", "-o", "out.profdata", "a.profraw", "b.profraw"],
    ["run"],
    ["run", "--out"],
    [],
  ]) {
    expect(programArgumentsStart(args), args.join(" ")).toBe(args.length);
  }
});

test("the help shows where run's options and the program's arguments go", () => {
  expect(USAGE).toContain("  scriptc run [options] <file.ts|.js> [args]\n");
  expect(USAGE).not.toMatch(/report-only/i);
});
