// The ways a function that reads the receiver of its call becomes a member,
// each followed by a call of that member on its holder: stored through a
// parameter, a variable, a computed key (literal, constant and unknown), an
// array or a Map and back, a spread, Object.assign, a class field, a default
// parameter, a generic identity function, a destructured member, a member
// read passed on, a conditional, a later assignment and a callback. Node
// passes the holder in every one.
type F = () => string;
function label(this: unknown): string {
  return this === undefined ? "no receiver" : "receiver";
}
function id<T>(x: T): T {
  return x;
}

function paramFactory(): void {
  function make(f: F) { return { name: "#h", make: f }; }
  const host = make(label as F);
  console.log("param-factory", host.make());
}

function computedLiteral(): void {
  const host = { name: "#h", ["make"]: label as F };
  console.log("computed-literal", host.make());
}

function computedConst(): void {
  const key = "make" as const;
  const host = { name: "#h", [key]: label as F };
  console.log("computed-const", host.make());
}

function computedUnknown(): void {
  const key: string = process.argv.length > 100 ? "other" : "make";
  const table: Record<string, F> = { [key]: label as F };
  console.log("computed-unknown", table.make!(), table[key]!());
}

function keyedAssignUnknown(): void {
  const key: string = process.argv.length > 100 ? "other" : "make";
  const table: Record<string, F> = {};
  table[key] = label as F;
  console.log("keyed-assign-unknown", table.make!());
}

function returned(): void {
  function pick(): F { return label as F; }
  const host = { name: "#h", make: pick() };
  console.log("returned", host.make());
}

function variableLet(): void {
  let g: F = () => "arrow";
  g = label as F;
  const host = { name: "#h", make: g };
  console.log("variable-let", host.make());
}

function variableConst(): void {
  const g = label as F;
  const host = { name: "#h", make: g };
  console.log("variable-const", host.make());
}

function shorthand(): void {
  const make = label as F;
  const host = { name: "#h", make };
  console.log("shorthand", host.make());
}

function arrayRoundtrip(): void {
  const fs: F[] = [label as F];
  const host = { name: "#h", make: fs[0]! };
  console.log("array-roundtrip", host.make());
}

function mapRoundtrip(): void {
  const table = new Map<string, F>([["k", label as F]]);
  const host = { name: "#h", make: table.get("k")! };
  console.log("map-roundtrip", host.make());
}

function objectSpread(): void {
  const base = { make: label as F };
  const host = { name: "#h", ...base };
  console.log("object-spread", host.make());
}

function objectAssign(): void {
  const host = Object.assign({ name: "#h" }, { make: label as F });
  console.log("object-assign", host.make());
}

function classField(): void {
  class Host { name = "#h"; make: F = label as F; }
  const host: { name: string; make: F } = new Host();
  console.log("class-field", host.make());
}

function defaultParam(): void {
  function make(f: F = label as F) { return { name: "#h", make: f }; }
  const host = make();
  console.log("default-param", host.make());
}

function genericIdentity(): void {
  const host = { name: "#h", make: id(label as F) };
  console.log("generic-identity", host.make());
}

function bind(): void {
  const host = { name: "#h", make: (label as F).bind({ name: "bound" }) };
  console.log("bind", host.make());
}

function destructured(): void {
  const src = { make: label as F };
  const { make } = src;
  const host = { name: "#h", run: make };
  console.log("destructured", host.run());
}

function memberRelay(): void {
  const src = { make: label as F };
  function relay(f: F) { return { name: "#h", run: f }; }
  const host = relay(src.make);
  console.log("member-relay", host.run());
}

function conditional(): void {
  const host = { name: "#h", make: process.argv.length > 100 ? (): string => "arrow" : (label as F) };
  console.log("conditional", host.make());
}

function assignLater(): void {
  const host: { name: string; make: F } = { name: "#h", make: () => "arrow" };
  host.make = label as F;
  console.log("assign-later", host.make());
}

function assignElement(): void {
  const host: { name: string; make: F } = { name: "#h", make: () => "arrow" };
  host["make"] = label as F;
  console.log("assign-element", host.make());
}

function callbackParam(): void {
  function later(cb: (f: F) => void): void { cb(label as F); }
  let host: { name: string; make: F } = { name: "#h", make: () => "arrow" };
  later((f) => { host = { name: "#h", make: f }; });
  console.log("callback-param", host.make());
}

function arrowOnly(): void {
  const host = { name: "#h", make: (): string => "arrow" };
  console.log("arrow-only", host.make(), label.call(host));
}

// A member whose function takes rest arguments, called with fewer and with
// more than its fixed parameters, in a program where every member carries.
type Log = (event: string, ...rest: unknown[]) => string;
function restSignature(): void {
  function make(log: Log): { log: Log } {
    return { log };
  }
  const target = make((event, ...rest) => `${event} ${rest.length}`);
  console.log("rest-signature", target.log("a"), target.log("b", 1, 2));
}

paramFactory();
computedLiteral();
computedConst();
computedUnknown();
keyedAssignUnknown();
returned();
variableLet();
variableConst();
shorthand();
arrayRoundtrip();
mapRoundtrip();
objectSpread();
objectAssign();
classField();
defaultParam();
genericIdentity();
bind();
destructured();
memberRelay();
conditional();
assignLater();
assignElement();
callbackParam();
arrowOnly();
restSignature();
