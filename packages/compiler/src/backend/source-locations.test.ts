import { expect, test } from "vitest";
import { type FilePrefixMap, shownFile, SourceLocations } from "./source-locations.js";

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

test("a file prefix map renames whole folders, the first match once", () => {
  const map: FilePrefixMap = [
    ["/work/stage/lib", "/work/lib"],
    ["/work/stage", "/work/app"],
    ["/work/app", "/work/other"],
  ];
  expect(shownFile("/work/stage/lib/a.ts", map)).toBe("/work/lib/a.ts");
  expect(shownFile("/work/stage/a.ts", map)).toBe("/work/app/a.ts");
  expect(shownFile("/work/stages/a.ts", map)).toBe("/work/stages/a.ts");

  // A filesystem root ends with its separator, as a source and as a target.
  expect(shownFile("/app/a.ts", [["/", "/work"]])).toBe("/work/app/a.ts");
  expect(shownFile("D:/app/a.ts", [["D:/", "C:/work"]])).toBe("C:/work/app/a.ts");
  expect(shownFile("/work/stage/a.ts", [["/work/stage", "/"]])).toBe("/a.ts");

  // Offsets are read from the source's own text and shown under its new name.
  const sources = new SourceLocations(new Map([["/work/stage/a.ts", "one\ntwo"]]), undefined, map);
  expect(sources.position({ file: "/work/stage/a.ts", start: 4, end: 7 })).toEqual({
    file: "/work/app/a.ts",
    line: 2,
    column: 1,
  });
});
