// Small functions returning a tuple or record that the caller destructures
// at once: string slices and numbers in the fields, a parameter that may be
// undefined at run time (a missing array element passed with `!`), fields
// the caller does not read, object destructuring in another order than the
// literal, arguments and fields with side effects, non-ASCII and astral
// receivers, slices that escape into arrays, closures and returns, bodies
// with loops and locals, a recursive producer, sites inside switch, try and
// loops, and an async caller.
const log: string[] = [];
function note(label: string, value: number): number {
  log.push(label);
  return value;
}

function split(text: string, at: number): [string, string] {
  return [text.slice(0, at), text.slice(at)];
}

function divmod(a: number, b: number): [number, number] {
  return [Math.floor(a / b), a % b];
}

interface Name {
  first: string;
  last: string;
}

function name(full: string): Name {
  const space = full.indexOf(" ");
  return { first: full.slice(0, space), last: full.slice(space + 1) };
}

function trimmed(text: string): [number, number] {
  let start = 0;
  let end = text.length;
  while (start < end && text.charCodeAt(start) === 32) start++;
  while (end > start && text.charCodeAt(end - 1) === 32) end--;
  return [start, end];
}

function noted(a: number, b: number): [number, number] {
  return [note("first field", a), note("second field", b)];
}

function digits(n: number): [number, string] {
  if (n < 10) return [1, String(n)];
  const [count, rest] = digits(Math.floor(n / 10));
  return [count + 1, rest + String(n % 10)];
}

const texts = ["alpha", "be", "", "x", "héllo", "a😀b"];
let total = 0;
const kept: string[] = [];
const later: (() => string)[] = [];
for (let i = 0; i < 40; i++) {
  const [q, r] = divmod(i * 31 - 200, 7);
  const [head, tail] = split(texts[i % texts.length]!, r % 4);
  total += q + r + head.length * 2 + tail.length;
  if (i % 9 === 0) kept.push(head);
  if (i % 11 === 0) later.push(() => tail);
}
console.log("total", total);
console.log("kept", kept.join("|"));
console.log("later", later.map((f) => f()).join("|"));

for (const [a, b] of [
  [7, 2],
  [-7, 2],
  [7.5, 2],
  [1, 0],
  [-1, 0],
  [0, -3],
]) {
  const [q, r] = divmod(a!, b!);
  console.log("divmod", a, b, q, r, Object.is(r, -0));
}
const [only] = divmod(17, 5);
console.log("only", only);

const { last, first } = name("Ada Lovelace");
console.log("name", first, last);
const { first: alone } = name("Grace Hopper");
console.log("alone", alone);

const [left, right] = trimmed("   padded text  ");
console.log("trimmed", left, right);

const [x, y] = noted(note("first argument", 1), note("second argument", 2));
console.log("order", x, y, log.join(", "));

const [count, spelled] = digits(90210);
console.log("digits", count, spelled);

for (const text of ["héllo", "a😀b", "日本語"]) {
  for (const at of [0, 1, 2, 3, -1, 10]) {
    const [head, tail] = split(text, at);
    console.log("unicode", text, at, head, tail, head.length, tail.length);
  }
}

function tails(): string[] {
  const out: string[] = [];
  for (const text of texts) {
    const [, tail] = split(text, 1);
    out.push(tail);
  }
  return out;
}
console.log("tails", tails().join("|"));

function lastTail(text: string): string {
  const [, tail] = split(text, 2);
  return tail;
}
console.log("lastTail", lastTail("returned"));

for (const kind of ["one", "two", "other"]) {
  switch (kind) {
    case "one": {
      const [h, t] = split("switch", 3);
      console.log("switch", kind, h, t);
      break;
    }
    case "two": {
      const [q, r] = divmod(-9, 4);
      console.log("switch", kind, q, r);
      break;
    }
    default:
      console.log("switch", kind);
  }
}

try {
  const [head, tail] = split(texts[99]!, 1);
  console.log("unreachable", head, tail);
} catch (error) {
  console.log("missing", (error as Error).name, (error as Error).message);
}

async function asyncCaller(text: string): Promise<string> {
  await Promise.resolve();
  const [head, tail] = split(text, 3);
  return `${head}-${tail}`;
}
asyncCaller("awaited").then((value) => console.log("async", value));
