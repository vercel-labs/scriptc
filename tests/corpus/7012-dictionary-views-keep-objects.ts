// A record or class instance converted to a string-keyed dictionary is
// the same object: writes through the dictionary reach it, and the
// dictionary is === to it.
const key = process.argv.length > 99 ? "never" : "added";
type Point = { a: string };

// A type-literal record stored straight in a dictionary binding.
const direct: Point = { a: "x" };
const directTable: Record<string, string> = direct;
directTable[key] = "y";
console.log(JSON.stringify(direct), (directTable as unknown) === direct);

// The same record through a `{}` view.
const viewed: Point = { a: "x" };
const view: {} = viewed;
const viewTable: Record<string, string> = view;
viewTable[key] = "y";
console.log(JSON.stringify(viewed));

// A declared index type, and a parameter.
interface Labels {
  [name: string]: string;
}
function label(table: Labels, name: string): void {
  table[name] = "set";
}
const passed: Point = { a: "x" };
label(passed, key);
console.log(JSON.stringify(passed));

// A `{}` parameter converted inside the function, called with a record
// and with a dictionary.
function viaView(value: {}): void {
  const table: Record<string, string> = value;
  table[key] = "y";
}
const record: Point = { a: "x" };
viaView(record);
const dictionary: Record<string, string> = { a: "x" };
viaView(dictionary);
console.log(JSON.stringify(record), JSON.stringify(dictionary));

// A class instance through a `{}` view: a computed write replaces a method.
class Greeter {
  name = "g";
  greet(): string {
    return "hello " + this.name;
  }
}
const greeter = new Greeter();
const greeterView: {} = greeter;
const slots: Record<string, string> = greeterView;
slots[process.argv.length > 99 ? "never" : "greet"] = "replaced";
slots["name"] = "renamed";
console.log(typeof greeter.greet, greeter.name, JSON.stringify(greeter));
// A write under a runtime string key replaces a method too, and a direct
// call reaches the replacement, which is not a function.
class Counter {
  n = 0;
  tick(): number {
    return ++this.n;
  }
}
const counter = new Counter();
const counterView: {} = counter;
const counterSlots: Record<string, string> = counterView;
const methodKey: string = process.argv.length > 99 ? "never" : "tick";
counterSlots[methodKey] = "replaced";
try {
  console.log(counter.tick());
} catch (error) {
  console.log((error as Error).name, (error as Error).message);
}
try {
  console.log(greeter.greet());
} catch (error) {
  console.log((error as Error).name, (error as Error).message);
}

// Deleting through the dictionary removes the key from the object.
const pruned: { a: string; b?: string } = { a: "x", b: "y" };
const prunedTable: Record<string, string | undefined> = pruned;
delete prunedTable[process.argv.length > 99 ? "never" : "b"];
console.log(JSON.stringify(pruned), "b" in pruned);

// A dictionary literal whose methods read `this` keeps its live object.
interface Table {
  [key: string]: () => number;
}
const table: Table = {
  base() {
    return 2;
  },
  twice() {
    return this.base() * 2;
  },
};
console.log(table.twice(), Object.keys(table).join(","));
