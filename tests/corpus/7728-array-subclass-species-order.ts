// map, filter and flatMap on a class that extends Array construct their
// result through the class before the first callback runs, with the
// receiver's length for map and 0 for filter and flatMap.
class Logged extends Array<number> {
  constructor(...args: number[]) {
    super(...args);
    console.log("construct", args.length === 1 ? `length ${args[0]}` : `${args.length} items`);
  }
}

const source = Logged.from([1, 2, 3]);
console.log("map");
const mapped = source.map((value) => {
  console.log("  callback", value);
  return value * 10;
});
console.log(mapped, mapped instanceof Logged);

console.log("filter");
const kept = source.filter((value) => {
  console.log("  callback", value);
  return value !== 2;
});
console.log(kept, kept instanceof Logged);

console.log("flatMap");
const spread = source.flatMap((value) => {
  console.log("  callback", value);
  return [value, -value];
});
console.log(spread.length, spread instanceof Logged);

console.log("map to strings");
const labels = source.map((value) => {
  console.log("  callback", value);
  return `#${value}`;
});
console.log(labels, labels instanceof Logged);

console.log("throwing callback");
try {
  source.map((value) => {
    if (value === 2) throw new Error(`stopped at ${value}`);
    return value;
  });
} catch (error) {
  console.log((error as Error).message);
}

console.log("plain receiver");
const plain: number[] = [4, 5];
console.log(plain.map((value) => value + 1), plain.filter((value) => value > 4));
