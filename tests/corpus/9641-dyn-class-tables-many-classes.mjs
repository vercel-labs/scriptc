// A program with seventy classes whose untyped code reaches the class
// tables every way they are built: `value instanceof ctor` and `new ctor()`
// with the constructor in a variable (class values, builtin constructors,
// plain functions, a class with a Symbol.hasInstance hook, and operands
// that are not constructors at all), computed reads and writes on class
// instances with string and symbol keys, and static members read through
// an untyped constructor. Two classes have keys of equal length that end
// alike, and one class is declared inside a function and made twice.
const tag = Symbol("tag");
class Base {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size;
  }
}
class AlphaThing extends Base {
  static label = "alpha";
  static describe() {
    return "alpha thing";
  }
}
class BravoThing extends Base {
  static label = "bravo";
}
class Tagged {
  constructor(size) {
    this.size = size;
    this[tag] = size * 10;
  }
}
class Even {
  static [Symbol.hasInstance](value) {
    return typeof value === "number" && value % 2 === 0;
  }
}
class C0 extends Base {
  weight() {
    return this.size + 0;
  }
}
class C1 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 1;
  }
}
class C2 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2;
  }
}
class C3 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 3;
  }
}
class C4 extends Base {
  weight() {
    return this.size + 4;
  }
}
class C5 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 5;
  }
}
class C6 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 6;
  }
}
class C7 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 7;
  }
}
class C8 extends Base {
  weight() {
    return this.size + 8;
  }
}
class C9 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 9;
  }
}
class C10 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 10;
  }
}
class C11 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 11;
  }
}
class C12 extends Base {
  weight() {
    return this.size + 12;
  }
}
class C13 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 13;
  }
}
class C14 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 14;
  }
}
class C15 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 15;
  }
}
class C16 extends Base {
  weight() {
    return this.size + 16;
  }
}
class C17 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 17;
  }
}
class C18 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 18;
  }
}
class C19 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 19;
  }
}
class C20 extends Base {
  weight() {
    return this.size + 20;
  }
}
class C21 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 21;
  }
}
class C22 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 22;
  }
}
class C23 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 23;
  }
}
class C24 extends Base {
  weight() {
    return this.size + 24;
  }
}
class C25 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 25;
  }
}
class C26 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 26;
  }
}
class C27 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 27;
  }
}
class C28 extends Base {
  weight() {
    return this.size + 28;
  }
}
class C29 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 29;
  }
}
class C30 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 30;
  }
}
class C31 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 31;
  }
}
class C32 extends Base {
  weight() {
    return this.size + 32;
  }
}
class C33 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 33;
  }
}
class C34 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 34;
  }
}
class C35 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 35;
  }
}
class C36 extends Base {
  weight() {
    return this.size + 36;
  }
}
class C37 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 37;
  }
}
class C38 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 38;
  }
}
class C39 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 39;
  }
}
class C40 extends Base {
  weight() {
    return this.size + 40;
  }
}
class C41 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 41;
  }
}
class C42 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 42;
  }
}
class C43 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 43;
  }
}
class C44 extends Base {
  weight() {
    return this.size + 44;
  }
}
class C45 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 45;
  }
}
class C46 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 46;
  }
}
class C47 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 47;
  }
}
class C48 extends Base {
  weight() {
    return this.size + 48;
  }
}
class C49 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 49;
  }
}
class C50 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 50;
  }
}
class C51 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 51;
  }
}
class C52 extends Base {
  weight() {
    return this.size + 52;
  }
}
class C53 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 53;
  }
}
class C54 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 54;
  }
}
class C55 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 55;
  }
}
class C56 extends Base {
  weight() {
    return this.size + 56;
  }
}
class C57 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 57;
  }
}
class C58 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 58;
  }
}
class C59 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 59;
  }
}
class C60 extends Base {
  weight() {
    return this.size + 60;
  }
}
class C61 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 61;
  }
}
class C62 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 62;
  }
}
class C63 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 63;
  }
}
class C64 extends Base {
  weight() {
    return this.size + 64;
  }
}
class C65 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 65;
  }
}
class C66 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 66;
  }
}
class C67 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 67;
  }
}
class C68 extends Base {
  weight() {
    return this.size + 68;
  }
}
class C69 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 69;
  }
}
const kinds = [
  C0, C1, C2, C3, C4, C5, C6, C7, C8, C9,
  C10, C11, C12, C13, C14, C15, C16, C17, C18, C19,
  C20, C21, C22, C23, C24, C25, C26, C27, C28, C29,
  C30, C31, C32, C33, C34, C35, C36, C37, C38, C39,
  C40, C41, C42, C43, C44, C45, C46, C47, C48, C49,
  C50, C51, C52, C53, C54, C55, C56, C57, C58, C59,
  C60, C61, C62, C63, C64, C65, C66, C67, C68, C69,
];
function isA(value, ctor) {
  return value instanceof ctor;
}
function make(ctor, size) {
  return new ctor(size);
}
function read(value, key) {
  return value[key];
}
function write(value, key, to) {
  value[key] = to;
  return value[key];
}
function labelOf(ctor) {
  return ctor.label;
}
function describerOf(ctor) {
  return ctor.describe;
}
function describe(ctor) {
  return ctor.describe();
}
function attempt(label, run) {
  try {
    console.log(label, run());
  } catch (error) {
    console.log(label, error.constructor === TypeError, error.message);
  }
}
function local(extra) {
  class Inner extends Base {
    weight() {
      return this.size + extra;
    }
  }
  return Inner;
}
const parts = kinds.map((kind, i) => make(kind, i));
// Every instance against every class: its own, its bases, and the rest.
let own = 0;
let inherited = 0;
let unrelated = 0;
for (let i = 0; i < parts.length; i++) {
  for (let k = 0; k < kinds.length; k++) {
    const yes = isA(parts[i], kinds[k]);
    if (i === k) own += yes ? 1 : 0;
    else if (yes) inherited++;
    else unrelated++;
  }
}
console.log(own, inherited, unrelated);
console.log(parts.filter((part) => isA(part, Base)).length, isA(parts[1], C0), isA(parts[0], C1));
// A chain of three: each instance against each class.
class Mid extends Base {}
class Leaf extends Mid {}
const chain = [make(Base, 1), make(Mid, 2), make(Leaf, 3)];
for (const ctor of [Base, Mid, Leaf]) console.log(chain.map((item) => isA(item, ctor)).join());
// Keys of equal length that end alike select one case and stay apart.
const alpha = make(AlphaThing, 3);
const bravo = make(BravoThing, 4);
console.log(isA(alpha, AlphaThing), isA(alpha, BravoThing), isA(bravo, BravoThing), isA(bravo, AlphaThing));
console.log(labelOf(AlphaThing), labelOf(BravoThing), labelOf(C1), labelOf(kinds[9]), read(C5, "name"), read(C6, "length"));
console.log(describe(AlphaThing), AlphaThing.describe === describerOf(AlphaThing), describerOf(kinds[8]));
// Operands that are no compiled class.
const record = { size: 1 };
console.log(isA(record, C0), isA(null, C0), isA(undefined, C2), isA(7, C3), isA("text", C4));
console.log(isA(/x/, RegExp), isA(record, RegExp), isA(new Date(0), Date), isA(parts[0], Date));
console.log(isA([], Array), isA(parts[2], Object), isA(record, Object), isA(new Map(), Map));
console.log(isA(4, Even), isA(5, Even), isA(parts[0], Even));
function Plain() {}
console.log(isA(record, Plain), isA(new Plain(), Plain), isA(parts[0], Plain));
attempt("record", () => isA(record, record));
attempt("arrow", () => isA(record, () => true));
// Construction through an untyped constructor.
console.log(make(C0, 2).weight(), make(C4, 2).weight(), make(kinds[1], 5).weight(), make(Base, 9).weight());
console.log(make(Array, 3).length, make(Map, undefined).size, isA(make(Plain, 1), Plain));
// What cannot be constructed is a TypeError (the message names the callee
// as written, which the helper does not know).
for (const callee of [record, () => 1]) {
  try {
    make(callee, 1);
  } catch (error) {
    console.log("construct", error.constructor === TypeError);
  }
}
// A class made twice by one function: two class values, one declaration.
const First = local(10);
const Second = local(20);
const first = make(First, 1);
console.log(first.weight(), make(Second, 1).weight(), isA(first, First), isA(first, Second), isA(first, Base));
// Computed keys on class instances: symbols, strings, misses, writes.
const tagged = make(Tagged, 4);
console.log(read(tagged, tag), read(parts[2], tag), read(parts[0], tag), read(record, tag));
console.log(read(parts[2], "size"), read(parts[5], "size"), read(parts[5], "missing"), read(record, "size"));
console.log(write(parts[2], tag, 99), read(parts[2], tag), write(tagged, tag, 41), read(tagged, tag));
console.log(write(parts[3], "size", 41), parts[3].size, parts[3].weight());
console.log(write(parts[4], "extra", "added"), read(parts[4], "extra"), Object.keys(parts[4]).join());
let sum = 0;
for (const part of parts) {
  const marked = read(part, tag);
  sum += marked === undefined ? read(part, "size") : marked;
}
console.log(sum, isA(tagged, Tagged), isA(tagged, kinds[2]));
