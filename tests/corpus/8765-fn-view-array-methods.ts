// A function held at a narrower function type, then handed to an array
// method: JavaScript calls every callback with the element, its index and
// the array, so a function that has those parameters receives them even
// when the slot it came through declares only the element.
function show(x: string, i?: number, all?: string[]): string {
  return `${x}:${i === undefined ? "_" : i}:${all === undefined ? "_" : all.length}`;
}
function plain(x: string): string {
  return x + "!";
}
function n1(f: (x: string) => string): (x: string) => string {
  return f;
}
const xs = ["a", "b", "c"];

// map: a direct reference, a view, a view through a parameter, and a
// function that really takes one parameter.
function each(f: (x: string) => string): string[] {
  return xs.map(f);
}
console.log("map", xs.map(show).join(" "), "|", xs.map(n1(show)).join(" "));
console.log("map", each(show).join(" "), "|", each(plain).join(" "), "|", each((x) => x + "?").join(" "));

// forEach, filter and the find family.
const seen: string[] = [];
function note(x: string, i?: number): void {
  seen.push(x + (i ?? "_"));
}
function nv(f: (x: string) => void): (x: string) => void {
  return f;
}
xs.forEach(nv(note));
function second(x: string, i?: number): boolean {
  return i === 1;
}
function nb(f: (x: string) => boolean): (x: string) => boolean {
  return f;
}
const isSecond = nb(second);
console.log("forEach", seen.join(" "));
console.log("filter", xs.filter(isSecond).join(","), xs.find(isSecond), xs.findIndex(isSecond));
console.log("find", xs.findLast(isSecond), xs.findLastIndex(isSecond), xs.some(isSecond), xs.every(isSecond));
console.log("honest", xs.filter(nb((x) => x !== "b")).join(","), xs.some(nb((x) => x === "c")));

// reduce passes the accumulator, the element, the index and the array.
function add(acc: number, x: number, i?: number, all?: number[]): number {
  return acc + x * (i ?? 100) + (all === undefined ? 1000 : 0);
}
function n2(f: (acc: number, x: number) => number): (acc: number, x: number) => number {
  return f;
}
console.log("reduce", [1, 2, 3].reduce(n2(add), 0), [1, 2, 3].reduce(n2((acc, x) => acc + x), 0));

// flatMap, and a chain whose stages are views.
function dup(x: string, i?: number): string[] {
  return [x, String(i ?? "_")];
}
function nd(f: (x: string) => string[]): (x: string) => string[] {
  return f;
}
console.log("flatMap", xs.flatMap(nd(dup)).join(" "));
const mapped = n1(show);
console.log("chain", xs.map(mapped).filter(isSecond).join(" "), xs.filter(isSecond).map(mapped).join(" "));

// (A rest or `arguments` function stored under a fixed signature and then
// handed to a caller that passes more is refused by name, SC1090: the rule
// of variadic-functions.ts, pinned by
// tests/diagnostics/variadic-store-longer-call.ts.)

// The callback's writes reach the array it is handed and a captured one.
const log: number[] = [];
function visit(x: number, i?: number, whole?: number[]): void {
  log.push(x * 10 + (i ?? 9));
  if (whole !== undefined && whole.length < 4) whole.push(7);
}
function nvn(f: (x: number) => void): (x: number) => void {
  return f;
}
const nums = [1, 2];
nums.forEach(nvn(visit));
console.log("writes", log.join(","), nums.join(","));
