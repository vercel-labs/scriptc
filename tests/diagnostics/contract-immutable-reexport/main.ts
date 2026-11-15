// The Immutable contract does not depend on how the marker reaches the
// annotation: a re-export, a renamed re-export, a namespace re-export and a
// renamed re-export reached through a namespace import all resolve to the
// package's declaration, and writes that reach the value are refused.
import type { Immutable as Direct } from "@scriptc/types";
import type * as Package from "@scriptc/types";
import type { Immutable } from "./frozen.ts";
import type { Frozen } from "./frozen-alias.ts";
import type * as S from "./frozen-namespace.ts";
import type * as Renamed from "./frozen-alias.ts";

const ROWS: Immutable<number[][]> = [[1], [2]];
const IDS: Frozen<number[]> = [1, 2, 3];
const TAGS: S.Immutable<string[]> = ["a", "b"];
const CODES: Direct<number[]> = [5, 6];
const NAMES: Package.Immutable<string[]> = ["x", "y"];
const SPANS: Renamed.Frozen<number[]> = [7, 8];

function grow(rows: number[][]): void {
  rows[0]!.push(3);
}

grow(ROWS as number[][]);
(IDS as number[]).push(4);
(TAGS as string[]).push("c");
(CODES as number[]).push(7);
(NAMES as string[]).push("z");
(SPANS as number[]).push(9);
console.log(ROWS.length, IDS.length, TAGS.length, CODES.length, NAMES.length, SPANS.length);
