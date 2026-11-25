// `let x: T;` assigned on first use inside a function. tsc checks the
// reads of such a binding only in the function that declares it, so the
// type can leave out `undefined` while the binding holds it until the
// first call. Every test of the binding has to see that undefined.

let cache: Map<string, number>;
function memo(key: string): number {
  if (cache === undefined) {
    console.log("new cache");
    cache = new Map();
  }
  const value = cache.get(key) ?? key.length;
  cache.set(key, value);
  return value;
}
console.log(memo("abc"), memo("abc"), memo("de"));

let counter: number;
function next(): number {
  if (counter === undefined) counter = 100;
  return counter++;
}
console.log(next(), next());

let total: number;
function addTo(n: number): number {
  total = (total || 0) + n;
  return total;
}
console.log(addTo(5), addTo(6));

let label: string;
function labelOrDefault(): string {
  return label ?? "anonymous";
}
console.log(labelOrDefault());
label = "set";
console.log(labelOrDefault());

let flag: boolean;
function flagState(): string {
  return flag === undefined ? "unset" : String(flag);
}
console.log(flagState());
flag = false;
console.log(flagState());

let list: number[];
function push(n: number): number {
  (list ??= []).push(n);
  return list.length;
}
console.log(push(1), push(2));

let point: { x: number };
function hasPoint(): boolean {
  return point !== undefined;
}
console.log(hasPoint());
point = { x: 1 };
console.log(hasPoint(), point.x);

class Service {
  id = 1;
}
let instance: Service;
function service(): Service {
  if (instance === undefined) {
    console.log("creating");
    instance = new Service();
  }
  return instance;
}
console.log(service().id, service() === service());

let started: boolean;
function start(): string {
  if (!started) {
    started = true;
    return "started";
  }
  return "already started";
}
console.log(start(), start());

// The same binding inside a function, captured by a closure that runs
// before the assignment.
function local(): string {
  let x: number;
  const peek = (): string => typeof x;
  const before = peek();
  x = 1;
  return before + ">" + peek();
}
console.log(local());

function localNumber(): string {
  let n: number;
  const read = (): number => n;
  const before = read();
  n = 5;
  return String(before) + ">" + read() + ">" + (before === undefined);
}
console.log(localNumber());

function lazyLocal(): number {
  let seen: Set<string>;
  const add = (s: string): number => {
    if (seen === undefined) seen = new Set();
    seen.add(s);
    return seen.size;
  };
  return add("a") + add("a") + add("b");
}
console.log(lazyLocal());
