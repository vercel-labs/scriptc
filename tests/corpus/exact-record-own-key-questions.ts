// "Is this value exactly the plain record its type names?", asked at source
// level where the value is held under its record type: the prototype is
// Object.prototype, and the own keys are the declared ones in the declared
// order. Each way of being (and of not being) exact answers as in Node, and
// so does every other use of the key list.
type R1 = { id: number };
type R4 = { id: number; author: string; text: string; note?: string };
type R11 = {
  a: number;
  b: string;
  c: boolean;
  d: number;
  e?: string;
  f: string;
  g: number;
  h: string;
  i?: number;
  j: string;
  k: number;
};
type Key = string | symbol;

// The prototype and the own enumerable names, in order.
function keys1(value: R1): boolean {
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === "id";
}
function keys4(value: R4): boolean {
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Object.keys(value);
  let at = 0;
  if (keys[at] !== "id") return false;
  at++;
  if (keys[at] !== "author") return false;
  at++;
  if (keys[at] !== "text") return false;
  at++;
  if (keys[at] === "note") at++;
  return at === keys.length;
}
// The same with every own name, enumerable or not.
function names4(value: R4): boolean {
  const names = Object.getOwnPropertyNames(value);
  if (names.length < 3 || names.length > 4) return false;
  return names[0] === "id" && "author" === names[1] && names[2] === `text` && (names.length === 3 || names[3] === "note");
}
// The prototype and every own key, string or symbol, all of them enumerable.
function own1(value: R1): boolean {
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === 1 && keys[0] === "id" && Object.keys(value).length === 1;
}
function own4(value: R4): boolean {
  if (Object.prototype !== Object.getPrototypeOf(value)) return false;
  const keys = Reflect.ownKeys(value);
  let at = 0;
  if (keys[at] !== "id") return false;
  at++;
  if (keys[at] !== "author") return false;
  at++;
  if (keys[at] !== "text") return false;
  at++;
  if (keys[at] === "note") at++;
  return at === keys.length && Object.keys(value).length === at;
}
function own11(value: R11): boolean {
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value);
  let at = 0;
  for (const name of ["a", "b", "c", "d"]) {
    if (name === "a" && keys[at] !== "a") return false;
    if (name === "b" && keys[at] !== "b") return false;
    if (name === "c" && keys[at] !== "c") return false;
    if (name === "d" && keys[at] !== "d") return false;
    at++;
  }
  if (keys[at] === "e") at++;
  if (keys[at] !== "f") return false;
  at++;
  if (keys[at] !== "g") return false;
  at++;
  if (keys[at] !== "h") return false;
  at++;
  if (keys[at] === "i") at++;
  if (keys[at] !== "j") return false;
  at++;
  if (keys[at] !== "k") return false;
  at++;
  return at === keys.length && Object.keys(value).length === at;
}

// Other uses of the list: each one reads the list itself.
function take(list: readonly Key[]): number {
  return list.length;
}
function listed(value: R4, name: string): string {
  const keys = Object.keys(value);
  const names = Object.getOwnPropertyNames(value);
  const own = Reflect.ownKeys(value);
  let out = keys.join("+") + " " + take(names) + " " + [...own].length;
  for (const key of own) out += " " + String(key);
  const count = (): number => names.length;
  out += " " + count() + (keys[0] === name) + (own[1] !== name);
  for (let i = 0; i < names.length; i++) {
    const key = names[i];
    out += key === "note" ? "!" : ".";
  }
  return out;
}
// Positions that no list holds, and an index evaluated once whatever it finds.
function positions(value: R4): string {
  const keys = Reflect.ownKeys(value);
  let at = 0;
  const flags = [
    keys[at++] === "missing",
    keys[at++] === "author",
    keys[-1] === "id",
    keys[0.5] === "id",
    keys[keys.length - 1] === "text",
    keys[keys.length] !== "text",
    keys[NaN] === "id",
  ];
  switch (keys.length) {
    case 3:
      return flags.join() + at + " three";
    case 4:
      return flags.join() + at + " four";
    default:
      return flags.join() + at + ` ${keys.length}`;
  }
}
// The list is what the record held when it was made.
function snapshot(value: R11): string {
  const keys = Object.keys(value);
  const before = keys.length + ":" + (keys[4] === "e") + (keys[4] === "f");
  value.e = "late";
  const after = Object.keys(value);
  const now = after.length + ":" + (after[4] === "e") + (after[4] === "f");
  delete value.e;
  return before + " " + keys.length + " " + now + " " + Object.keys(value).length;
}
// A list declared in a block of its own, in a loop, and beside another.
function scoped(value: R4): string {
  let out = "";
  for (let round = 0; round < 2; round++) {
    const keys = Object.keys(value);
    {
      const keys = Reflect.ownKeys(value);
      if (keys[2] !== "text") out += "?";
      out += keys.length;
    }
    out += keys[0] === "id" ? "I" : "i";
    try {
      const names = Object.getOwnPropertyNames(value);
      if (names.length > 3) throw new Error("many");
      out += names[1] === "author" ? "A" : "a";
    } catch (error) {
      out += "caught";
    }
  }
  return out;
}

function show(label: string, value: R4): void {
  console.log(
    label + ": keys " + keys4(value) + ", names " + names4(value) + ", own " + own4(value) + ", scoped " + scoped(value),
  );
  console.log("  " + listed(value, "id") + " | " + positions(value));
}
function show11(label: string, value: R11): void {
  console.log(label + ": own " + own11(value) + ", list " + Object.keys(value).join(","));
}

class Impl {
  id: number;
  author: string;
  text: string;
  constructor(id: number) {
    this.id = id;
    this.author = "ada";
    this.text = "class";
  }
}
function addKey(value: R4): void {
  const held: { [key: string]: unknown } = value as unknown as { [key: string]: unknown };
  held.extra = 1;
}

function main(): void {
  // Exact records.
  show("exact, optional absent", { id: 1, author: "a", text: "t" });
  show("exact, optional present", { id: 1, author: "a", text: "t", note: "n" });
  const one: R1 = { id: 1 };
  console.log("one member: keys " + keys1(one) + ", own " + own1(one));
  const big: R11 = { a: 1, b: "b", c: true, d: 4, e: "e", f: "f", g: 7, h: "h", i: 9, j: "j", k: 11 };
  show11("eleven members", big);
  const gaps: R11 = { a: 1, b: "b", c: true, d: 4, f: "f", g: 7, h: "h", j: "j", k: 11 };
  show11("eleven members, optional absent", gaps);
  console.log("snapshot: " + snapshot(gaps));
  show11("after the snapshot", gaps);

  // A wider object under the narrower type.
  const source = { id: 1, author: "a", text: "t", extra: 5 };
  const wide: R4 = source;
  show("wider object", wide);
  const wideOne = { id: 1, more: 2 };
  const narrowOne: R1 = wideOne;
  console.log("wider one member: keys " + keys1(narrowOne) + ", own " + own1(narrowOne));
  const json = { id: 2, author: "b", text: "u", toJSON: (): string => "json" };
  const serializable: R4 = json;
  show("own enumerable toJSON", serializable);

  // The declared keys in another order.
  show("another key order", { text: "t", id: 2, author: "b" });
  show("optional member before a required one", { id: 1, author: "a", note: "n", text: "t" });

  // Frozen, and members that come and go.
  const frozen: R4 = Object.freeze({ id: 1, author: "a", text: "t" });
  show("frozen record", frozen);
  const changing: R11 = { a: 1, b: "b", c: true, d: 4, e: "e", f: "f", g: 7, h: "h", i: 9, j: "j", k: 11 };
  delete changing.e;
  show11("member deleted", changing);
  changing.e = "again";
  show11("member deleted and added again", changing);
  const late: R4 = { id: 1, author: "a", text: "t" };
  late.note = "late";
  show("optional member added later", late);
  const middle: R11 = { a: 1, b: "b", c: true, d: 4, f: "f", g: 7, h: "h", j: "j", k: 11 };
  middle.e = "late";
  show11("optional member in the middle added later", middle);

  // A class instance, and records converted from untyped values.
  const instance: R4 = new Impl(3);
  show("class instance", instance);
  show("parsed, exact", JSON.parse('{"id":1,"author":"a","text":"t"}') as R4);
  show("parsed, wider", JSON.parse('{"id":1,"author":"a","text":"t","extra":2}') as R4);
  show("parsed, another order", JSON.parse('{"author":"a","id":1,"text":"t"}') as R4);

  // What an untyped view of the record was given.
  const mark = Symbol("mark");
  const marked: R4 = { id: 1, author: "a", text: "t" };
  const untyped: { [key: symbol]: number } = marked as unknown as { [key: symbol]: number };
  untyped[mark] = 1;
  show("symbol member added through an untyped view", marked);
  const reparented: R4 = { id: 1, author: "a", text: "t" };
  const held: object = reparented;
  Object.setPrototypeOf(held, { inherited: 1 });
  show("prototype replaced through a held view", reparented);
  console.log(Object.getPrototypeOf(held) === Object.prototype);
  const extended: R4 = { id: 1, author: "a", text: "t" };
  addKey(extended);
  show("member added through a dropped untyped view", extended);
}

main();
