// A function in an array or tuple slot serializes as null; an
// index-signature entry holding one is omitted; a function passed as the
// value itself makes JSON.stringify answer undefined.
const callbacks: Array<() => number> = [() => 1, () => 2];
console.log(JSON.stringify(callbacks), JSON.stringify([] as Array<() => void>));

const mixed: Array<number | (() => number)> = [1, () => 2, 3];
console.log(JSON.stringify(mixed));
mixed.push(() => 4, 5);
console.log(JSON.stringify(mixed, null, 1));

const optional: Array<string | (() => void) | undefined | null> = ["a", () => {}, undefined, null];
console.log(JSON.stringify(optional));

const tuple: [number, () => void, string] = [1, () => {}, "s"];
const pair: [string | (() => string), boolean] = [() => "lazy", true];
console.log(JSON.stringify(tuple), JSON.stringify(pair), JSON.stringify([tuple, tuple]));

const handlers: Record<string, () => void> = {};
handlers["open"] = () => {};
handlers["close"] = () => {};
console.log(JSON.stringify(handlers), Object.keys(handlers).length);

const table: { [key: string]: number | (() => number) } = {};
table["one"] = 1;
table["lazy"] = () => 2;
table["three"] = 3;
console.log(JSON.stringify(table));
console.log(JSON.stringify({ handlers, table, list: callbacks }, null, 2));

interface Registry {
  version: number;
  [name: string]: number | ((input: string) => string);
}
const registry: Registry = { version: 1 };
registry["upper"] = (input) => input.toUpperCase();
registry["count"] = 2;
console.log(JSON.stringify(registry));

// A function stored under the key toJSON is the hook, whatever the type
// calls the key: JSON.stringify calls it with the property's key.
handlers["toJSON"] = () => {};
console.log(JSON.stringify(handlers), JSON.stringify([handlers]), JSON.stringify({ handlers }));
const named: Record<string, () => string> = { first: () => "f" };
console.log(JSON.stringify(named));
named["toJSON"] = () => "hooked";
console.log(JSON.stringify(named), JSON.stringify([named]), JSON.stringify({ wrap: named }, null, 1));
table["toJSON"] = () => 42;
console.log(JSON.stringify(table), JSON.stringify({ table }));
registry["toJSON"] = (key) => `key:${key}`;
console.log(JSON.stringify(registry), JSON.stringify({ registry }), JSON.stringify([registry]));

const grid: Array<Array<(() => void) | number>> = [[1, () => {}], [], [() => {}]];
console.log(JSON.stringify(grid));

let calls = 0;
function make(): (x: number) => number {
  calls++;
  return (x) => x + 1;
}

function roots(): void {
  const text = JSON.stringify(make());
  console.log(text === undefined, typeof text, calls);
  console.log(JSON.stringify((x: number) => x) ?? "missing");
  console.log(`${JSON.stringify(make())}`, calls);
  JSON.stringify(make());
  console.log(calls, JSON.stringify(make(), null, 2) === undefined);
}
roots();
