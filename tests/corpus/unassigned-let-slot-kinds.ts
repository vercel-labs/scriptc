// Every kind of slot a `let` declared without an initializer can have,
// read by a function before the first assignment and again after it:
// numbers (a float and an integer counter), a boolean, a string, a bigint,
// an array, a Map, a Set, a class instance, a record, a function, a union,
// a nullable and a tuple. Before the assignment each reads undefined:
// `typeof`, both strict comparisons, `== null`, truthiness and `??`.

class Svc {
  id = 1;
}
type Rec = { a: number };
const DA: number[] = [9];
const DM = new Map<string, number>();
const DS = new Set<string>();
const DI = new Svc();
const DR: Rec = { a: 9 };
const DF = (x: number): number => x;
const DT: [number, string] = [0, "z"];

// Module level.
let n: number;
let i: number;
let b: boolean;
let s: string;
let big: bigint;
let arr: number[];
let m: Map<string, number>;
let st: Set<string>;
let inst: Svc;
let rec: Rec;
let fn: (x: number) => number;
let un: string | number;
let nul: string | null;
let tup: [number, string];
function showModule(): void {
  console.log(
    "n",
    typeof n,
    n === undefined,
    n !== undefined,
    n == null,
    n ? "truthy" : "falsy",
    (n ?? -1) === -1,
  );
  console.log(
    "i",
    typeof i,
    i === undefined,
    i !== undefined,
    i == null,
    i ? "truthy" : "falsy",
    (i ?? -2) === -2,
  );
  console.log(
    "b",
    typeof b,
    b === undefined,
    b !== undefined,
    b == null,
    b ? "truthy" : "falsy",
    (b ?? true) === true,
  );
  console.log(
    "s",
    typeof s,
    s === undefined,
    s !== undefined,
    s == null,
    s ? "truthy" : "falsy",
    (s ?? "dflt") === "dflt",
  );
  console.log(
    "big",
    typeof big,
    big === undefined,
    big !== undefined,
    big == null,
    big ? "truthy" : "falsy",
    (big ?? 5n) === 5n,
  );
  console.log(
    "arr",
    typeof arr,
    arr === undefined,
    arr !== undefined,
    arr == null,
    arr ? "truthy" : "falsy",
    (arr ?? DA) === DA,
  );
  console.log(
    "m",
    typeof m,
    m === undefined,
    m !== undefined,
    m == null,
    m ? "truthy" : "falsy",
    (m ?? DM) === DM,
  );
  console.log(
    "st",
    typeof st,
    st === undefined,
    st !== undefined,
    st == null,
    st ? "truthy" : "falsy",
    (st ?? DS) === DS,
  );
  console.log(
    "inst",
    typeof inst,
    inst === undefined,
    inst !== undefined,
    inst == null,
    inst ? "truthy" : "falsy",
    (inst ?? DI) === DI,
  );
  console.log(
    "rec",
    typeof rec,
    rec === undefined,
    rec !== undefined,
    rec == null,
    rec ? "truthy" : "falsy",
    (rec ?? DR) === DR,
  );
  console.log(
    "fn",
    typeof fn,
    fn === undefined,
    fn !== undefined,
    fn == null,
    (fn ?? DF) === DF,
  );
  console.log(
    "un",
    typeof un,
    un === undefined,
    un !== undefined,
    un == null,
    un ? "truthy" : "falsy",
    (un ?? "dflt") === "dflt",
  );
  console.log(
    "nul",
    typeof nul,
    nul === undefined,
    nul !== undefined,
    nul == null,
    nul ? "truthy" : "falsy",
    (nul ?? "dflt") === "dflt",
  );
  console.log(
    "tup",
    typeof tup,
    tup === undefined,
    tup !== undefined,
    tup == null,
    tup ? "truthy" : "falsy",
    (tup ?? DT) === DT,
  );
}
showModule();
n = 1.5;
i = 3;
b = false;
s = "";
big = 0n;
arr = [];
m = new Map();
st = new Set();
inst = new Svc();
rec = { a: 1 };
fn = (x: number) => x * 2;
un = 0;
nul = null;
tup = [1, "t"];
for (let k = 0; k < 2; k++) i += k;
showModule();

// Function level, captured by a nested function.
function run(): void {
  let n: number;
  let i: number;
  let b: boolean;
  let s: string;
  let big: bigint;
  let arr: number[];
  let m: Map<string, number>;
  let st: Set<string>;
  let inst: Svc;
  let rec: Rec;
  let fn: (x: number) => number;
  let un: string | number;
  let nul: string | null;
  let tup: [number, string];
  function showLocal(): void {
    console.log(
      "n",
      typeof n,
      n === undefined,
      n !== undefined,
      n == null,
      n ? "truthy" : "falsy",
      (n ?? -1) === -1,
    );
    console.log(
      "i",
      typeof i,
      i === undefined,
      i !== undefined,
      i == null,
      i ? "truthy" : "falsy",
      (i ?? -2) === -2,
    );
    console.log(
      "b",
      typeof b,
      b === undefined,
      b !== undefined,
      b == null,
      b ? "truthy" : "falsy",
      (b ?? true) === true,
    );
    console.log(
      "s",
      typeof s,
      s === undefined,
      s !== undefined,
      s == null,
      s ? "truthy" : "falsy",
      (s ?? "dflt") === "dflt",
    );
    console.log(
      "big",
      typeof big,
      big === undefined,
      big !== undefined,
      big == null,
      big ? "truthy" : "falsy",
      (big ?? 5n) === 5n,
    );
    console.log(
      "arr",
      typeof arr,
      arr === undefined,
      arr !== undefined,
      arr == null,
      arr ? "truthy" : "falsy",
      (arr ?? DA) === DA,
    );
    console.log(
      "m",
      typeof m,
      m === undefined,
      m !== undefined,
      m == null,
      m ? "truthy" : "falsy",
      (m ?? DM) === DM,
    );
    console.log(
      "st",
      typeof st,
      st === undefined,
      st !== undefined,
      st == null,
      st ? "truthy" : "falsy",
      (st ?? DS) === DS,
    );
    console.log(
      "inst",
      typeof inst,
      inst === undefined,
      inst !== undefined,
      inst == null,
      inst ? "truthy" : "falsy",
      (inst ?? DI) === DI,
    );
    console.log(
      "rec",
      typeof rec,
      rec === undefined,
      rec !== undefined,
      rec == null,
      rec ? "truthy" : "falsy",
      (rec ?? DR) === DR,
    );
    console.log(
      "fn",
      typeof fn,
      fn === undefined,
      fn !== undefined,
      fn == null,
      (fn ?? DF) === DF,
    );
    console.log(
      "un",
      typeof un,
      un === undefined,
      un !== undefined,
      un == null,
      un ? "truthy" : "falsy",
      (un ?? "dflt") === "dflt",
    );
    console.log(
      "nul",
      typeof nul,
      nul === undefined,
      nul !== undefined,
      nul == null,
      nul ? "truthy" : "falsy",
      (nul ?? "dflt") === "dflt",
    );
    console.log(
      "tup",
      typeof tup,
      tup === undefined,
      tup !== undefined,
      tup == null,
      tup ? "truthy" : "falsy",
      (tup ?? DT) === DT,
    );
  }
  showLocal();
  n = 1.5;
  i = 3;
  b = false;
  s = "";
  big = 0n;
  arr = [];
  m = new Map();
  st = new Set();
  inst = new Svc();
  rec = { a: 1 };
  fn = (x: number) => x * 2;
  un = 0;
  nul = null;
  tup = [1, "t"];
  for (let k = 0; k < 2; k++) i += k;
  showLocal();
}
run();
