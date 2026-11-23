import { expect, test } from "vitest";
import { SourceLocations } from "./source-locations.js";

test("source offsets use their own file, UTF-16 columns, and JS line separators", () => {
  const text = "one\r\ntwo\rthree\nfour\u2028five\u2029😀six";
  const sources = new SourceLocations(
    new Map([
      ["main.ts", "short"],
      ["other.ts", text],
    ]),
  );
  for (const [index, word] of ["one", "two", "three", "four", "five", "😀six"].entries()) {
    const offset = text.indexOf(word);
    expect(
      sources.position({ file: "other.ts", start: offset, end: offset + word.length }),
    ).toEqual({
      file: "other.ts",
      line: index + 1,
      column: 1,
    });
  }
  expect(
    sources.position({ file: "other.ts", start: text.indexOf("six"), end: text.length })?.column,
  ).toBe(3);
  expect(sources.position({ file: "missing.ts", start: 0, end: 0 })).toBeNull();
  expect(sources.position({ file: "main.ts", start: -1, end: -1 })).toBeNull();
});

test("a file the build carries no text for is read once through the loader", () => {
  const text = "alpha\nbeta\r\ngamma";
  const reads: string[] = [];
  const sources = new SourceLocations(new Map(), (file) => {
    reads.push(file);
    return file === "late.ts" ? text : undefined;
  });
  const beta = text.indexOf("beta");
  expect(sources.position({ file: "late.ts", start: beta, end: beta + 4 })).toEqual({
    file: "late.ts",
    line: 2,
    column: 1,
  });
  // The table is built once per file.
  expect(sources.position({ file: "late.ts", start: text.indexOf("gamma"), end: 0 })?.line).toBe(3);
  expect(reads).toEqual(["late.ts"]);
  // A file that cannot be read has no positions, and is not read again.
  expect(sources.position({ file: "gone.ts", start: 0, end: 0 })).toBeNull();
  expect(sources.position({ file: "gone.ts", start: 0, end: 0 })).toBeNull();
  expect(reads).toEqual(["late.ts", "gone.ts"]);
  // Text the build carries is never loaded twice from disk.
  const carried = new SourceLocations(new Map([["main.ts", "one\ntwo"]]), (file) => {
    reads.push(file);
    return "nope";
  });
  expect(carried.position({ file: "main.ts", start: 4, end: 7 })?.line).toBe(2);
  expect(reads).toEqual(["late.ts", "gone.ts"]);
});
