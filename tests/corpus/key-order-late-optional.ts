// An optional key that no literal creates is appended when it is first
// assigned, after every key the value was built with, and straight-line
// assignments of several such keys keep their program order, including
// assignments behind conditions. Assigning a key that already exists never
// moves it.
interface Item {
  label?: string;
  id: number;
  done: boolean;
}
function makeItem(id: number): Item {
  return { id, done: false };
}
const item = makeItem(1);
item.label = "first";
console.log(Object.keys(item).join(","), JSON.stringify(item));
console.log(item);
const direct: Item = { id: 2, done: true };
direct.label = "second";
console.log(Object.keys(direct).join(","), JSON.stringify(direct));
const untouched = makeItem(3);
console.log(JSON.stringify(untouched), Object.keys(untouched).join(","));

// Two late keys assigned in reverse declaration order.
interface Pos {
  id: number;
  x?: number;
  y?: number;
}
function makePos(): Pos {
  return { id: 0 };
}
const pos = makePos();
pos.y = 1;
pos.x = 2;
console.log(Object.keys(pos).join(","), JSON.stringify(pos));
console.log(pos);
pos.id = 3;
console.log(JSON.stringify(pos));

// An options object filled key by key, some keys conditionally.
interface Opts {
  verbose?: boolean;
  depth?: number;
  name?: string;
}
function build(deep: boolean, loud: boolean): Opts {
  const o: Opts = {};
  o.name = "n";
  if (deep) o.depth = 2;
  if (loud) o.verbose = true;
  return o;
}
for (const deep of [true, false])
  for (const loud of [true, false]) console.log(JSON.stringify(build(deep, loud)));
console.log(build(true, true));
const forIn: string[] = [];
for (const k in build(true, true)) forIn.push(k);
console.log(forIn.join(","));

// Late keys on records stored in arrays and Maps.
interface Task {
  owner?: string;
  title: string;
  priority: number;
}
const tasks: Task[] = [];
for (let i = 0; i < 3; i++) tasks.push({ title: "t" + i, priority: i });
for (const t of tasks) if (t.priority > 0) t.owner = "o" + t.priority;
console.log(JSON.stringify(tasks));
const byTitle = new Map<string, Task>();
for (const t of tasks) byTitle.set(t.title, t);
console.log(byTitle);

// An explicit undefined is a present key at its literal position.
interface Maybe {
  a?: number;
  b: number;
}
function makeMaybe(): Maybe {
  return { b: 1, a: undefined };
}
console.log(Object.keys(makeMaybe()).join(","), JSON.stringify(makeMaybe()));
console.log(makeMaybe());
