// A record passed to a parameter whose type lacks some of its required
// fields is the caller's object inside a callee that writes through the
// parameter or compares it: the writes reach the caller's record and `===`
// answers for the object itself, as in Node.

type Common = { id?: string | null; format?: string; index?: number };
type Note = { kind: "note"; text: string; mark?: string | null } & Common;

function fill(target: Common, source: Note): void {
  target.id ??= source.id;
  target.format ||= source.format;
  target.index ??= source.index;
}
const first: Note = { kind: "note", text: "a" };
const second: Note = { kind: "note", text: "b", id: "x", format: "f", index: 2 };
fill(first, second);
first.text += second.text;
console.log(first.kind, first.text, first.id, first.format, first.index, first.mark);
console.log(JSON.stringify(first), Object.keys(first).join(","));

// The fields the parameter's type names come first in the argument's type.
type Entry = Common & { kind: "entry"; text: string };
const entry: Entry = { kind: "entry", text: "e", index: 7 };
fill(entry, second);
console.log(entry.kind, entry.text, entry.id, entry.format, entry.index);
console.log(Object.keys(entry).sort().join(","));

// Identity comparisons and plain writes, through bindings, members and
// elements.
interface Named {
  name: string;
  alias?: string;
}
interface Item {
  name: string;
  alias?: string;
  count: number;
  tags: string[];
}
function same(a: Named, b: Named): boolean {
  return a === b;
}
function rename(target: Named, name: string): void {
  target.name = name;
}
function shout(target: Named): string {
  return target.name.toUpperCase();
}
const one: Item = { name: "one", count: 1, tags: ["t"] };
const two: Item = { name: "two", count: 2, tags: [] };
const holder = { item: one };
const items: Item[] = [one, two];
console.log(same(one, one), same(one, two), same(holder.item, one), same(two, one));
rename(one, "uno");
rename(holder.item, holder.item.name + "!");
for (const item of items) rename(item, item.name + "?");
console.log(one.name, two.name, holder.item.name, shout(one), one.count, two.tags.length);

// What a body does with the parameter: return it, enumerate it, store it,
// capture it, delete through it, recurse, forward it.
function touch(t: Named): Named {
  t.name += "+";
  return t;
}
function keys(t: Named): string {
  t.alias ??= "al";
  return `${Object.keys(t).sort().join(",")}|${JSON.stringify({ ...t }).length}|${"count" in t}`;
}
const seen: Named[] = [];
function remember(t: Named): number {
  t.name = t.name.toLowerCase();
  seen.push(t);
  return seen.length;
}
function later(t: Named): () => string {
  t.alias = "set";
  return () => `${t.name}:${t.alias}`;
}
function drop(t: Named): boolean {
  return delete t.alias;
}
function countDown(t: Named, n: number): number {
  if (n === 0) return 0;
  t.name += n;
  return 1 + countDown(t, n - 1);
}
function forward(t: Named): void {
  t.name += "/";
  touch(t);
}
function pick({ name }: Named, t: Named): string {
  t.name = `${name}=`;
  return t.name;
}
const subject: Item = { name: "Subject", count: 3, tags: ["x", "y"] };
const touched = touch(subject);
console.log(subject.name, touched.name, subject.count);
console.log(keys(subject), subject.alias);
console.log(remember(subject), subject.name, seen[0]!.name);
const read = later(subject);
subject.name = "changed";
console.log(read(), subject.alias);
console.log(drop(subject), subject.alias, "alias" in subject);
console.log(countDown(subject, 3), subject.name);
forward(subject);
console.log(subject.name);
console.log(pick(subject, subject), subject.name, subject.tags.join());

// A frozen record refuses the write through the parameter.
function stamp(target: Common): void {
  "use strict";
  target.id = "stamped";
}
const frozen: Note = { kind: "note", text: "f" };
Object.freeze(frozen);
try {
  stamp(frozen);
  console.log("no throw", frozen.id);
} catch (e) {
  console.log(e instanceof TypeError, frozen.id);
}

// One function, several argument layouts.
type Mark = { kind: "mark"; level: number } & Common;
const mark: Mark = { kind: "mark", level: 2 };
const bare: Common = {};
fill(mark, second);
fill(bare, second);
console.log(mark.id, mark.level, bare.id, bare.index);
