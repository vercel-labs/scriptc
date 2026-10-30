// An array or record passed to a parameter whose type lacks some of its
// optional fields is the caller's value inside the callee: pushes, index
// stores, element-field writes and removals through the parameter reach the
// caller's array, as in Node.

interface Param {
  id: string;
  name: string;
  owned?: true;
}
type Slot = { id: string; name: string };

function addSlot(params: Slot[], name: string): void {
  params.push({ id: `${name}.0`, name });
}
function rename(params: Slot[], index: number, name: string): void {
  params[index]!.name = name;
}
function replace(params: Slot[], index: number, slot: Slot): void {
  params[index] = slot;
}
function removeFirst(params: Slot[]): string | undefined {
  return params.shift()?.name;
}
function forward(params: Slot[], name: string): void {
  addSlot(params, name);
  addSlot(params, `${name}2`);
}
function names(params: Slot[]): string {
  return params.map((p) => p.name).join(",");
}

const params: Param[] = [{ id: "a.0", name: "a", owned: true }];
addSlot(params, "b");
rename(params, 0, "first");
replace(params, 1, { id: "z.0", name: "z" });
forward(params, "c");
console.log(params.length, JSON.stringify(params));
console.log(removeFirst(params), params.length, params[0]?.owned, names(params));
params.splice(1, 1);
console.log(names(params));

const holder = { list: params };
addSlot(holder.list, "d");
console.log(holder.list.length, params.length, holder.list === params);

// A record parameter: writes to its fields reach the caller's record, and the
// optional field the parameter's type lacks stays as the caller left it.
interface Counter {
  label: string;
  hits: number;
  note?: string;
}
function bump(target: { label: string; hits: number }): void {
  target.hits += 1;
  target.label = target.label.toUpperCase();
}
const counter: Counter = { label: "c", hits: 1 };
const noted: Counter = { label: "n", hits: 0, note: "kept" };
bump(counter);
bump(counter);
bump(noted);
console.log(JSON.stringify(counter), "note" in counter, JSON.stringify(noted));

// Recursion through the same parameter.
function fill(params: Slot[], n: number): void {
  if (n === 0) return;
  addSlot(params, `r${n}`);
  fill(params, n - 1);
}
const deep: Param[] = [];
fill(deep, 3);
console.log(names(deep), deep.length);

// Recursive layouts: a tree with an optional field passed where a tree
// without it is expected.
interface Tree {
  label: string;
  kids: Tree[];
  note?: string;
}
interface Plain {
  label: string;
  kids: Plain[];
}
function addKid(t: Plain, label: string): void {
  t.kids.push({ label, kids: [] });
}
function size(t: Plain): number {
  let n = 1;
  for (const k of t.kids) n += size(k);
  return n;
}
const tree: Tree = { label: "r", kids: [{ label: "a", kids: [], note: "leaf" }] };
addKid(tree, "b");
console.log(size(tree), tree.kids.map((k) => k.label).join(","), tree.kids[0]!.note);
