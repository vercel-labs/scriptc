// console.log of an array lists its named and numeric properties after the
// elements, as Node's util.inspect does: typed arrays written through an
// unknown view, regex match results, arrays from JSON.parse, holes, Node's
// column grouping and the 100-entry limit.

type Bag = Record<string, unknown>;

const named: number[] = [1, 2, 3];
(named as unknown as Bag).extra = "named";
console.log(named);

const words: string[] = ["a"];
(words as unknown as Bag)["my-key"] = { deep: [1, { x: 1 }] };
console.log(words, [words]);

const empty: number[] = [];
(empty as unknown as Bag).x = 1;
console.log(empty);

const numeric: number[] = [1, 2];
numeric[-1] = 5;
numeric[1.5] = 6;
console.log(numeric);

const holes: (number | undefined)[] = [1, , 3];
(holes as unknown as Bag).tail = true;
console.log(holes);

const grid: number[] = [];
for (let i = 0; i < 30; i++) grid.push(i * 7);
(grid as unknown as Bag).label = "grid";
console.log(grid);

const long: number[] = [];
for (let i = 0; i < 120; i++) long.push(i);
(long as unknown as Bag).label = "long";
console.log(long);

const full: number[] = [];
for (let i = 0; i < 100; i++) full.push(i);
(full as unknown as Bag).label = "full";
console.log(full);

const match = /b(?<rest>c)?/.exec("abc");
console.log(match);
const plainMatch = /x/.exec("axb");
console.log(plainMatch);

const parsed = JSON.parse("[1,2,3,4,5,6,7,8]") as unknown as Bag;
parsed.extra = "named";
console.log(parsed);

const plain: number[] = [1, 2, 3];
console.log(plain, [] as number[]);

const accessed: number[] = [1, 2];
const accessedBag = accessed as unknown as Bag;
Object.defineProperty(accessedBag, "both", { get: () => 1, set: (_v: unknown) => {}, enumerable: true });
Object.defineProperty(accessedBag, "getter", { get: () => 2, enumerable: true });
Object.defineProperty(accessedBag, "setter", { set: (_v: unknown) => {}, enumerable: true });
console.log(accessed);
