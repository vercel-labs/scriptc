/* A type that belongs to no class of record types (frontend/union-classes.ts)
 * and has the layout of one's member maps to the class's record
 * (classRecordOfLayout in type-mapper.ts): its values enter the union with
 * no conversion. These tests pin that on the lowered program, whichever of
 * the two types the pass maps first; the behavior is the corpus program
 * union-class-member-shaped-values.ts. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze } from "../src/index.js";
import { memberNamesKey } from "../src/frontend/union-classes.js";

function conversions(source: string): { refusals: string[]; copies: string[]; warnings: number } {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-union-class-layouts-"));
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(entry, source);
    const result = analyze(entry);
    return {
      refusals: result.coverage.diagnostics.map((d) => d.code),
      copies: (result.widthCopies ?? []).map((fact) => fact.kind),
      warnings: (result.coverage.divergences ?? []).filter((d) => d.code === "SC6001").length,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const UNION = `type Book = { kind: "print"; title: string };
type Loan = { kind: "print"; title: string; reader: string };
type Tape = { kind: "audio"; minutes: number };
type Entry = Book | Loan | Tape;
`;
const NONE = { refusals: [], copies: [], warnings: 0 };

test("a value mapped before its union's class enters the union without a conversion", () => {
  expect(
    conversions(
      `${UNION}const held = { kind: "print" as const, title: "t" };\nconst stored: Entry = held;\nif (stored.kind === "print") stored.title = "w";\nconsole.log(held.title, stored === held);`,
    ),
  ).toEqual(NONE);
});

test("a value mapped after the class does too", () => {
  expect(
    conversions(
      `${UNION}const first: Entry = { kind: "audio", minutes: 1 };\nconst held = { kind: "print" as const, title: "t", reader: "r" };\nconst stored: Entry = held;\nheld.reader = "w";\nconsole.log(JSON.stringify(first), JSON.stringify(stored), stored === held);`,
    ),
  ).toEqual(NONE);
});

test("a member's type written a second time and an asserted type are the class's record", () => {
  expect(
    conversions(
      `${UNION}type Volume = { kind: "print"; title: string };\nconst volume: Volume = { kind: "print", title: "v" };\nconst parsed = JSON.parse('{"kind":"print","title":"p"}') as { kind: "print"; title: string };\nconst all: Entry[] = [volume, parsed];\nvolume.title = "w";\nconsole.log(JSON.stringify(all), all[0] === volume, all[1] === parsed);`,
    ),
  ).toEqual(NONE);
});

test("a type with other properties than every member converts by a copy the scan reports", () => {
  const held = `${UNION}const held = { kind: "print" as const, title: "t", pages: 3 };\nconst stored: Entry = held;\n`;
  expect(conversions(`${held}console.log(JSON.stringify(stored), held.pages);`)).toEqual({
    refusals: [],
    copies: ["width"],
    warnings: 0,
  });
  expect(
    conversions(
      `${held}if (stored.kind === "print") stored.title = "w";\nconsole.log(held.title);`,
    ),
  ).toEqual({ refusals: [], copies: ["width"], warnings: 1 });
});

const SECOND = `type Reprint = { kind: "print"; title: string };
type Signed = { kind: "print"; title: string; SIGNER };
type Poster = { kind: "sheet"; width: number };
type Stock = Reprint | Signed | Poster;
const shared: Book = { kind: "print", title: "s" };
const inStock: Stock = shared;
const inCatalogue: Entry = shared;
if (inStock.kind === "print") inStock.title = "w";
console.log(inStock === shared, inCatalogue === shared, shared.title);`;

test("a member written in two unions is one record in both", () => {
  expect(conversions(UNION + SECOND.replace("SIGNER", "signer: string"))).toEqual(NONE);
});

test("two unions whose classes declare one name with two types keep the layout they share", () => {
  expect(conversions(UNION + SECOND.replace("SIGNER", "reader: number"))).toEqual(NONE);
});

test("the names of a layout are one key in any order", () => {
  expect(memberNamesKey(["title", "kind"])).toBe(memberNamesKey(["kind", "title"]));
  expect(memberNamesKey(["kind", "title"])).not.toBe(memberNamesKey(["kind", "title", "reader"]));
});
