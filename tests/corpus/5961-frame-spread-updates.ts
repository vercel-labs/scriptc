// Same-shape spread updates (`{ ...state, field: value }`) of records that
// hold strings and arrays: each update reads the whole old value before
// any override evaluates, releases the replaced fields exactly once, and
// keeps the previous value when an override throws. Aliases, identity,
// storage and printing keep the heap object Node would have.
interface State {
  name: string;
  count: number;
  items: string[];
  last: string | undefined;
}
interface Num {
  count: number;
  total: number;
}
function bump(s: State, item: string): State {
  return { ...s, count: s.count + 1, last: item };
}
function rename(s: State, name: string): State {
  return name.length > 3 ? { ...s, name } : s.count > 2 ? { ...s, name: name + "!" } : bump(s, name);
}
function check(n: number): number {
  if (n === 3) throw new Error("three");
  return n * 2;
}
function describe(s: State): string {
  return `${s.name}:${s.count}:${s.items.length}:${s.last ?? "-"}`;
}

function run(n: number): string {
  let state: State = { name: "s", count: 0, items: ["a"], last: undefined };
  let out = "";
  for (let i = 0; i < n; i++) {
    state = { ...state, count: state.count + 1 };
    if (i % 2 === 0) state = { ...state, last: "i" + i, name: state.name + i };
    state = bump(state, "b" + i);
    state = rename(state, i % 3 === 0 ? "long" + i : "x");
    try {
      state = { ...state, count: check(i) };
    } catch (e) {
      out += "!";
    }
    out += describe(state) + " ";
  }
  return out + state.items.join("");
}
console.log(run(6));

function numeric(n: number): number {
  let state: Num = { count: 0, total: 0 };
  for (let i = 0; i < n; i++) {
    state = { ...state, count: state.count + 1 };
    if (i % 3 === 0) state = { ...state, total: state.total + i };
  }
  return state.count * 1000 + state.total;
}
console.log(numeric(10));

// Overrides see the old value and run after the copy.
function order(): string {
  let s: State = { name: "n", count: 1, items: [], last: "l" };
  let log = "";
  s = { ...s, name: (log += s.name + s.count, s.name + "2"), count: s.count + 10 };
  s = { ...s, last: s.name };
  return `${log} ${describe(s)}`;
}
console.log(order());

// Spread of a temporary and of a producer result.
function fresh(i: number): State {
  return { name: "f" + i, count: i, items: [String(i)], last: undefined };
}
function temporaries(n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) {
    const s = { ...fresh(i), count: 100 + i };
    const t = { ...s, items: [s.name, s.name] };
    out += describe(s) + "/" + describe(t) + " ";
  }
  return out;
}
console.log(temporaries(3));

// Aliases and identity are observable: these stay heap objects.
let current: State = { name: "c", count: 0, items: [], last: undefined };
const before = current;
current = { ...current, count: 5 };
console.log(before === current, before.count, current.count);
const history: State[] = [];
let tracked: State = { name: "h", count: 0, items: [], last: undefined };
for (let i = 0; i < 3; i++) {
  tracked = { ...tracked, count: tracked.count + 1 };
  history.push(tracked);
}
console.log(history.map((s) => s.count).join(","), history[0] === history[1]);
console.log({ ...tracked, last: "shown" });
