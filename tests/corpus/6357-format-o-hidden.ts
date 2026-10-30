// util.format's %o over values reached through `unknown` renders with
// showHidden, as Node does: arrays show their hidden `[length]` (with
// Node's grouping), at every depth, inside Maps and records too, ahead of
// an array's named properties.
import { format } from "node:util";
const cases: [string, unknown][] = [
  ["ten", Array.from({ length: 10 }, (_, i) => i)],
  ["wide", Array.from({ length: 120 }, (_, i) => i)],
  ["hundred", Array.from({ length: 100 }, (_, i) => i)],
  ["hundred-one", Array.from({ length: 101 }, (_, i) => i)],
  ["hundred-strs", Array.from({ length: 100 }, (_, i) => "s" + i)],
  ["seven", ["aaaaaaaaaaaaaaaaaaaa", "b", "c", "d", "e", "f", "g"]],
  ["strs", Array.from({ length: 30 }, (_, i) => "s" + i)],
  ["holes", [1, , 3]],
  ["empty", []],
  ["nested", { list: [[]], m: new Map([[1, [2]]]) }],
  ["deep", [[[[[[1]]]]]]],
  ["date", [new Date(0)]],
];
for (const [k, v] of cases) console.log(k, format("%o", v));
// The hidden `[length]` comes before an array's named properties, and the
// grid's last-entry rule counts both.
type Bag = Record<string, unknown>;
const named = [1, 2];
(named as unknown as Bag).foo = "x";
const tagged = Array.from({ length: 100 }, (_, i) => i);
(tagged as unknown as Bag).tag = "t";
const bare: number[] = [];
(bare as unknown as Bag).k = 1;
for (const [k, v] of [
  ["named", named],
  ["tagged", tagged],
  ["bare", bare],
] as [string, unknown][])
  console.log(k, format("%o", v));
