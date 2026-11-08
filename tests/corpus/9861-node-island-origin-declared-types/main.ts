// @requires-libnode
// A value that comes out of a Node island stays the island's one object
// under whatever type the program reads it through: an interface of the
// project's own declaration file, an interface of a workspace package that
// holds only declarations, or a type the program asserts. The origin decides,
// not the declaration: writes go to the island's object, the island's later
// writes are read, and the island gets its own object back. The same
// interfaces type records the program makes, and a copy is made only where
// the program copies (structuredClone, a spread, JSON).
import { bump, each, holder, later, make, peek, raw, read, same, shared, take } from "kit";
import type { Entry } from "entry-types";

function show(item: Item): string {
  return `${item.name}/${item.count}/${item.nested.level}`;
}
function showEntry(entry: Entry): string {
  return `${entry.name}/${entry.count}/${entry.nested.level}`;
}

// A call's result, an import binding and a member of an island object.
const made = make("made");
console.log(show(made), made.label(), same(made));
made.count = 5;
bump();
console.log(show(made), made.label(), peek());
console.log(show(shared), show(holder.item), same(shared), same(holder.item));
shared.nested.level = 50;
console.log(read(shared), shared === shared);

// A parameter of a function the island calls.
each((item) => {
  item.name = item.name + "!";
  console.log(show(item), item.label(), same(item));
});
console.log(peek());

// The value an island promise settles with.
const awaited = await later("later");
awaited.nested.level = 9;
console.log(show(awaited), read(awaited), same(awaited));

// An assertion is a view of the island's object, not a copy: applied to the
// island call, through `unknown`, to a const that holds the value, and where
// the value went through a program function's parameter and return.
const direct = raw("direct") as Item;
direct.count = 11;
console.log(show(direct), read(direct), same(direct), direct.label());
const twice = raw("twice") as unknown as Item;
twice.count = 12;
console.log(show(twice), read(twice), same(twice));
const held = raw("held");
const viewed = held as Item;
viewed.count = 13;
bump();
console.log(show(viewed), read(held), same(viewed));
function asItem(value: unknown): Item {
  return value as Item;
}
function fetchRaw(name: string): unknown {
  return raw(name);
}
const through = asItem(fetchRaw("through"));
through.count = 14;
console.log(show(through), read(through), same(through), through.label());

// An interface of a workspace package that holds only declarations, as the
// type argument of an island's generic function.
const entry = take<Entry>("entry");
entry.count += 1;
console.log(showEntry(entry), read(entry), same(entry), entry.label());

// The program's own values of the same interfaces are the program's objects:
// the island reads them where they are.
const mine: Item = { name: "mine", count: 1, nested: { level: 1 }, label: () => "mine#" };
const own: Entry = { name: "own", count: 3, nested: { level: 3 }, label: () => "own#" };
console.log(show(mine), mine.label(), read(mine), showEntry(own), read(own));
mine.count = 2;
own.nested.level = 4;
console.log(read(mine), read(own), JSON.stringify(mine));

// A copy is made where the program copies.
const clone = structuredClone(entry);
const spread = { ...entry, extra: true };
bump();
console.log(clone.count, spread.count, spread.extra, entry.count, same(clone), JSON.stringify(entry));

// A value stored where its origin is not followed (an element of an untyped
// array) and asserted after it is read back. These interfaces come from
// declaration files, so they stay views of the island's object there too;
// an interface of the program's own source would be converted, and so
// copied, which is why the build names the store (SC6007).
const bag: unknown[] = [];
bag.push(raw("stored"));
const stored = bag[0] as Item;
stored.count = 15;
bump();
console.log(show(stored), read(stored), same(stored), stored.label());
const storedEntry = bag[0] as Entry;
storedEntry.nested.level = 21;
console.log(showEntry(storedEntry), read(stored), same(storedEntry));
