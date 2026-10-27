// An element index the checker types as a number can be undefined at run
// time (an element read from a holey array). JavaScript then names the
// array's "undefined" property, not "NaN": plain, compound, update and
// destructuring writes store it, a write used as a value yields the value,
// and reads (number, string, record and array elements) read it back.
const holey: number[] = [1];
holey[3] = 3;

const values: number[] = [0, 0, 0, 0];
values[NaN] = 10;
for (const i of holey) values[i] = 7;
console.log(values[NaN], values.join(","));
let total = 0;
for (const i of holey) total += values[i]!;
console.log(total);

const counts: number[] = [0, 0, 0, 0];
counts[NaN] = 10;
let trace = "";
for (const i of holey) trace += counts[i]++ + ",";
for (const i of holey) counts[i] += 2;
for (const i of holey) trace += --counts[i] + ";";
console.log(counts[NaN], counts.join(","), trace);

let last = 0;
for (const i of holey) last = values[i] = 5;
for (const i of holey) [values[i]] = [8];
console.log(last, values[NaN], values.join(","));

const names: string[] = ["a", "b", "c", "d"];
for (const i of holey) names[i] += "!";
const seen: (string | undefined)[] = [];
for (const i of holey) seen.push(names[i]);
console.log(names.join("|"), seen.join("|"));

interface Point {
  x: number;
}
const points: Point[] = [{ x: 0 }, { x: 1 }];
const shared: Point = { x: 9 };
let same = "";
for (const i of holey) {
  points[i] = shared;
  same += String(points[i] === shared) + " ";
}
shared.x = 10;
for (const i of holey) same += String(points[i]?.x) + " ";
console.log(same);

const fresh: number[] = [1, 2];
let missing = "";
for (const i of holey) missing += String(fresh[i]) + " ";
console.log(missing);
