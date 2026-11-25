// JSON.stringify of a JSON value type spelled with every primitive, bigint,
// symbol and undefined included, and holding itself through arrays and an
// index signature. The type-directed serializer has no answer for a symbol
// or a bigint, so such a value goes through the runtime traversal, which
// answers as Node does: undefined and a symbol drop from an object and are
// null in an array, and a bigint is a TypeError.
type Entry = string | number | boolean | null | undefined | symbol | bigint | Entry[] | Log;
interface Log {
  [key: string]: Entry;
}

const watch: Log = {
  keeper: "Ines",
  flashes: 4,
  lit: true,
  relief: undefined,
  swell: [1.5, undefined, "calm", null, [2, undefined]],
  fog: { horn: "long", cleared: undefined, bearings: [] },
};

// The object type, the whole value type, and a union with a string.
function page(log: Log): string {
  return JSON.stringify(log);
}
function any(entry: Entry): string {
  return JSON.stringify(entry);
}
function shown(value: Log | string): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
console.log(page(watch));
console.log(any(watch) === page(watch), any([watch, 3]), any("dusk"), any(7), any(null), any(false));
console.log(shown(watch).length, shown("plain"));
console.log(JSON.stringify(watch, null, 2));

// A symbol drops from an object and is null in an array.
const marked: Log = { buoy: Symbol("north"), lamps: [Symbol("spare"), 2], range: 12 };
console.log(page(marked));

// A bigint is Node's TypeError, wherever it sits.
const ledger: Log = { oil: 40n };
for (const entry of [ledger, [1, 2n], { deep: { deeper: [3n] } }] as Entry[]) {
  try {
    console.log(any(entry));
  } catch (e) {
    console.log((e as Error).name + ": " + (e as Error).message);
  }
}

// The text is an ordinary string and parses back.
const text = page(watch);
const back = JSON.parse(text) as Log;
console.log(text.length, text.startsWith('{"keeper"'), Object.keys(back).join(","), page(back) === text);
