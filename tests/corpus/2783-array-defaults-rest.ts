const numbers: number[] = [];
numbers[2] = 8;
numbers.length = 5;
let defaults = 0;
function fallback(): number {
  defaults++;
  return 42;
}
const [first = fallback(), second = fallback(), third = fallback(), ...tail] = numbers;
console.log("defaults", first, second, third, defaults);
tail.forEach((value, index) => console.log("tail", index, typeof value, value));
console.log("tail-length", tail.length, numbers.length);
let assigned = 0;
let rest: number[] = [];
[assigned = fallback(), ...rest] = numbers;
console.log("assigned", assigned, defaults);
rest.forEach((value, index) => console.log("rest", index, typeof value, value));
const values: (number | undefined)[] = [undefined, 9];
const [explicit = fallback(), present = fallback(), absent = fallback()] = values;
console.log("optional", explicit, present, absent, defaults);
const empty: number[] = [];
const [outOfRange = fallback(), ...emptyRest] = empty;
console.log("empty", outOfRange, emptyRest.length, defaults);
