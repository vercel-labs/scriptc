// A function value whose argument can be a missing element and whose result
// is a missing read: the call answers `undefined`, compared directly or
// bound to a name first.
const second = (text: string) => text.split("/")[1];
const paths = ["x/y", "z"];
console.log(second(paths[0]), second(paths[1]) === undefined);
const third = (text: string) => text.split("/")[2];
console.log(third("a/b") === undefined);
const kept = second(paths[1]);
console.log(kept === undefined);

const sizes = [3, 4];
const tail = (list: number[], from: number) => list[from + 1];
console.log(tail(sizes, sizes[0]) === undefined, tail(sizes, 0));

function main(): void {
  const parts = ["a.b", "c"];
  const suffix = (text: string) => text.split(".")[1];
  const found = suffix(parts[1]);
  console.log(found === undefined, suffix(parts[0]), suffix(parts[1]) === undefined);
  const label = (text: string) => (text === undefined ? "none" : text.split(".")[1]);
  console.log(label(parts[5]), label(parts[0]), label(parts[1]) === undefined);
}
main();
