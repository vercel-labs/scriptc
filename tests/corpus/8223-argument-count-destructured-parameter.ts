// A function with a destructured parameter that reads arguments.length,
// called through a value (map passes three arguments) and directly. The
// count is taken before the parameters bind, so each call sees its own.

function probe({ v, w }: { v: number; w: string }): string {
  return `${arguments.length}:${v}${w}`;
}

console.log([{ v: 1, w: "a" }, { v: 2, w: "b" }].map(probe));
console.log(probe({ v: 3, w: "c" }));
const call = (f: (item: { v: number; w: string }, index: number) => string): string =>
  f({ v: 4, w: "d" }, 0);
console.log(call(probe));
console.log(probe({ v: 5, w: "e" }));
