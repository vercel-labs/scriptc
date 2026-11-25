// String(), template literals and concatenation of a union that has record
// or array arms: each arm converts as it would alone. A plain record prints
// Object.prototype.toString's text, an array its join, a unit its name.
type Override = { limit?: number; reserve?: number };
type Table = { [key: string]: Override | undefined };

function isUsable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Object.keys(value).length > 0;
}

function check(table: Table | undefined, key: string | undefined): string {
  const entry = key !== undefined ? table?.[key] : undefined;
  if (entry !== undefined && !isUsable(entry)) {
    return `Invalid entry "${key}": ${String(entry)}. Expected a usable object.`;
  }
  return entry === undefined ? "none" : JSON.stringify(entry);
}

console.log(check({ a: { limit: 1 } }, "a"));
console.log(check({ a: { limit: 1 } }, "b"));
console.log(check({ a: {} }, "a"));
console.log(check(undefined, "a"));
console.log(check({ a: {} }, undefined));

function show(value: Override | undefined): string {
  return String(value);
}
function showNull(value: Override | null): string {
  return `<${value}>`;
}
function showMixed(value: Override | string | number | undefined): string {
  return "v=" + value;
}
function showList(value: number[] | Override | undefined): string {
  return String(value);
}
function showWords(value: string[] | boolean | null): string {
  return `${value}`;
}
function showHoles(value: (string | undefined)[] | Override): string {
  return String(value);
}

console.log(show({ limit: 2 }), show(undefined), show({}));
console.log(showNull({ reserve: 1 }), showNull(null));
console.log(showMixed({ limit: 3 }), showMixed("s"), showMixed(4.5), showMixed(undefined));
console.log(showList([1, 2, 3]), showList([]), showList({ limit: 1 }), showList(undefined));
console.log(showWords(["a", "b"]), showWords(true), showWords(null));
console.log(showHoles(["a", undefined, "c"]), showHoles({ limit: 9 }));

// The operand evaluates once.
let calls = 0;
function next(): Override | undefined {
  calls++;
  return calls % 2 === 1 ? { limit: calls } : undefined;
}
console.log(String(next()), String(next()), `${next()}`, calls);

// Elements of an array read past its end.
const overrides: Override[] = [{ limit: 1 }];
console.log(String(overrides[0]), String(overrides[1]));
