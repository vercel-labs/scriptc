export {};

// A closure created above a `let`/`const` it captures holds the binding in
// its temporal dead zone until the declaration runs. A binding of a
// reference type joined with `null` or `undefined` may legitimately hold
// that unit value afterwards; it must read as the value, not as the TDZ.

function attempt(label: string, action: () => void): void {
  try {
    action();
    console.log(label, "ok");
  } catch (error) {
    if (error instanceof Error) console.log(label, error.name, error.message);
  }
}

class Node2 {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
}

// The lowering shape that tripped the self-hosted compiler: a host object
// whose callback memoizes into later-declared bindings.
interface Host {
  keys(): Set<string>;
}
class Owner {
  private readonly host: Host;
  constructor(host: Host) {
    this.host = host;
  }
  count(): number {
    return this.host.keys().size;
  }
}
function memoized(): void {
  let computed = 0;
  const owner = new Owner({ keys: () => (cache ??= compute()) });
  let cache: Set<string> | null = null;
  const compute = (): Set<string> => {
    computed++;
    return new Set(["a", "b"]);
  };
  console.log("memoized", owner.count(), owner.count(), computed);
}
memoized();

function setArm(): void {
  const read = (): string => (value === null ? "null" : `size ${value.size}`);
  const write = (): void => {
    value = new Set([1, 2, 3]);
  };
  const clear = (): void => {
    value = null;
  };
  attempt("set read before", () => console.log(read()));
  attempt("set write before", write);
  let value: Set<number> | null = null;
  console.log("set initial", read());
  write();
  console.log("set written", read());
  clear();
  console.log("set cleared", read());
}
setArm();

function stringArm(): void {
  const fill = (): string => (value ??= "filled");
  const read = (): string => String(value);
  attempt("string fill before", () => console.log(fill()));
  let value: string | undefined = undefined;
  console.log("string initial", read());
  console.log("string fill", fill(), fill());
  value = "";
  console.log("string empty or", value || "fallback", JSON.stringify(read()));
  value ||= "or-assigned";
  console.log("string or-assign", read());
}
stringArm();

function arrayArm(): void {
  const push = (n: number): number => (value ??= []).push(n);
  const length = (): number => value?.length ?? -1;
  const joined = (): string => value?.join(",") ?? "none";
  attempt("array length before", () => console.log(length()));
  let value: number[] | undefined = undefined;
  console.log("array initial", length(), joined());
  push(4);
  push(5);
  console.log("array pushed", length(), joined());
  value = undefined;
  console.log("array reset", length());
}
arrayArm();

function mapArm(): void {
  const get = (k: string): string => value?.get(k) ?? "missing";
  const ensure = (): Map<string, string> => (value ??= new Map([["k", "v"]]));
  let value: Map<string, string> | null = null;
  console.log("map initial", get("k"));
  ensure().set("j", "w");
  console.log("map ensured", get("k"), get("j"), ensure().size);
}
mapArm();

function classArm(): void {
  const name = (): string => value?.name ?? "none";
  const swap = (next: Node2 | null): string => {
    const before = name();
    value = next;
    return `${before}->${name()}`;
  };
  attempt("class swap before", () => console.log(swap(new Node2("early"))));
  let value: Node2 | null = null;
  console.log("class", swap(new Node2("first")), swap(null), swap(new Node2("second")));
}
classArm();

function recordArm(): void {
  const label = (): string => (value === undefined ? "undefined" : value.label);
  const point = { label: "p", x: 1 };
  let value: { label: string; x: number } | undefined = undefined;
  console.log("record initial", label());
  value = point;
  console.log("record set", label(), value.x);
}
recordArm();

// `null` and `undefined` are distinct values of the same binding.
function bothUnits(): void {
  const describe = (): string =>
    value === undefined ? "undefined" : value === null ? "null" : value.name;
  const set = (next: Node2 | null | undefined): void => {
    value = next;
  };
  attempt("both read before", () => console.log(describe()));
  let value: Node2 | null | undefined = undefined;
  console.log("both", describe());
  set(null);
  console.log("both", describe());
  set(new Node2("present"));
  console.log("both", describe());
  set(undefined);
  console.log("both", describe());
}
bothUnits();

function constBinding(): void {
  const read = (): string => (value === null ? "const null" : value.join("+"));
  attempt("const read before", () => console.log(read()));
  const value: string[] | null = Math.random() < 2 ? null : ["never"];
  console.log(read());
}
constBinding();

// Every iteration has its own binding and its own temporal dead zone.
function loop(): void {
  const readers: (() => string)[] = [];
  for (let i = 0; i < 3; i++) {
    const reader = (): string => (value === null ? `null@${i}` : value);
    readers.push(reader);
    if (i === 1) attempt("loop read before", () => console.log(reader()));
    let value: string | null = i === 2 ? "two" : null;
  }
  console.log("loop", readers.map((reader) => reader()).join(" "));
}
loop();

// A forward-captured binding inside a reference cycle (closure -> box ->
// instance -> closure) is reclaimed without touching the empty sentinel.
class Holder {
  callback: () => string = () => "unset";
}
function cycle(): string {
  const holder = new Holder();
  holder.callback = () =>
    value === null ? "cycle null" : value.callback === holder.callback ? "cycle self" : "cycle other";
  let value: Holder | null = null;
  const first = holder.callback();
  value = holder;
  return `${first}, ${holder.callback()}`;
}
for (let i = 0; i < 3; i++) console.log(cycle());

// The empty box is released when its scope unwinds before initialization;
// a closure that escaped the frame still sees the temporal dead zone.
let escapedRead: () => number = () => -1;
function abandoned(): void {
  escapedRead = () => value?.length ?? 0;
  if (Math.random() < 2) throw new Error("unwound before declaration");
  let value: number[] | null = null;
  console.log("abandoned unreachable", escapedRead());
}
attempt("abandoned", abandoned);
attempt("escaped read", () => console.log(escapedRead()));
