// The ambient Boolean as an array callback beyond filter: every, some,
// find, findIndex and map call it with the element first, so each answers
// ToBoolean of the element (later arguments are ignored). filter(Boolean)
// also covers elements the checker types `any`.
const flags = [true, true, false];
console.log(flags.every(Boolean), flags.some(Boolean), flags.slice(0, 2).every(Boolean));
const counts = [0, 3, 0, 7];
console.log(counts.find(Boolean), counts.findIndex(Boolean), counts.map(Boolean).join(","));
const names = ["", "a", "", "b"];
console.log(names.some(Boolean), names.every(Boolean), names.findIndex(Boolean));
const maybe: (string | undefined)[] = [undefined, "x", undefined];
console.log(maybe.some(Boolean), maybe.find(Boolean), maybe.map(Boolean).join(","));

// Elements the checker types `any` keep their runtime kind; filter(Boolean)
// answers their runtime truthiness.
function untyped(value: unknown): any {
  return value;
}
const configFiles = [untyped("app.json"), untyped(""), untyped(undefined), untyped("site.json")].filter(
  Boolean,
) as string[];
console.log(configFiles.length, configFiles.join(","));

async function check(n: number): Promise<boolean> {
  return n % 2 === 1;
}

async function main(): Promise<void> {
  const all = (await Promise.all([1, 3, 5].map(async (n) => check(n)))).every(Boolean);
  const any = (await Promise.all([2, 4].map(async (n) => check(n)))).some(Boolean);
  console.log(all, any);
}

main();
