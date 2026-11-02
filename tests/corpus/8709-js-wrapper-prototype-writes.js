// The builtin prototypes a compiled call site reaches natively (t262-da A2):
// String, Number, Boolean, BigInt, Symbol and Date are the intrinsic table's
// objects too, so a key a program adds to one is an ordinary property of the
// prototype, held by the same object every dynamic read answers. Replacing
// an existing member stays refused by name (tests/harness/
// intrinsic-refusals.test.ts): `n.toFixed(2)` calls the runtime function, so
// the replacement would never be observed.
const lines = [];
const show = (name, value) => lines.push(name + "=" + String(value));

// A new key on each deferred owner's prototype is honoured.
Number.prototype.addedNumber = 7;
Boolean.prototype.addedBoolean = true;
String.prototype.addedString = "s";
Symbol.prototype.addedSymbol = "sym";
BigInt.prototype.addedBigInt = 5n;
Date.prototype.addedDate = "d";

show("reads", [
  Number.prototype.addedNumber,
  Boolean.prototype.addedBoolean,
  String.prototype.addedString,
  Symbol.prototype.addedSymbol,
  BigInt.prototype.addedBigInt,
  Date.prototype.addedDate,
].join("|"));

// The write is an own property of the prototype object, with Node's
// attributes for a plain assignment.
show("own", [
  Object.getOwnPropertyNames(Number.prototype).includes("addedNumber"),
  Object.getOwnPropertyNames(Boolean.prototype).includes("addedBoolean"),
  Object.getOwnPropertyNames(String.prototype).includes("addedString"),
  Object.getOwnPropertyNames(Symbol.prototype).includes("addedSymbol"),
  Object.getOwnPropertyNames(BigInt.prototype).includes("addedBigInt"),
  Object.getOwnPropertyNames(Date.prototype).includes("addedDate"),
].join("|"));
show("hasOwn", Object.hasOwn(Number.prototype, "addedNumber"));
show("in", "addedNumber" in Number.prototype);
const descriptor = Object.getOwnPropertyDescriptor(Number.prototype, "addedNumber");
show("descriptor", [descriptor.value, descriptor.writable, descriptor.enumerable, descriptor.configurable].join("|"));

// The prototype `X.prototype` names is the one a value of X answers, before
// and after the write.
show("protoOfPrimitive", [
  Object.getPrototypeOf(5) === Number.prototype,
  Object.getPrototypeOf("s") === String.prototype,
  Object.getPrototypeOf(true) === Boolean.prototype,
  Object.getPrototypeOf(new Date(0)) === Date.prototype,
].join("|"));
show("protoProto", [
  Object.getPrototypeOf(Number.prototype) === Object.prototype,
  Object.getPrototypeOf(Boolean.prototype) === Object.prototype,
  Object.getPrototypeOf(String.prototype) === Object.prototype,
  Object.getPrototypeOf(Symbol.prototype) === Object.prototype,
  Object.getPrototypeOf(BigInt.prototype) === Object.prototype,
  Object.getPrototypeOf(Date.prototype) === Object.prototype,
].join("|"));
show("identity", [
  Number.prototype === Number.prototype,
  Date.prototype === Date.prototype,
].join("|"));

// A write inside a function body lands on the same object.
function addFromFunction() {
  String.prototype.fromFunction = 1;
  return String.prototype.fromFunction;
}
show("fromFunction", addFromFunction());

// A definition with a new literal key is the same ordinary property.
Object.defineProperty(Number.prototype, "defined", {
  value: 3,
  writable: true,
  enumerable: false,
  configurable: true,
});
show("defined", Number.prototype.defined);

// A property of a member is a property of the interned function.
Number.prototype.toFixed.custom = 1;
show("memberProperty", Number.prototype.toFixed.custom + " " + typeof Number.prototype.toFixed);

// Number, String and Boolean prototypes are wrapper objects around a
// primitive (+0, "" and false), so a member called on the prototype object
// itself runs on that value. (A String method with a statically lowered
// receiver, `String.prototype.slice(1)`, still refuses the prototype object
// on the base branch as well; that path is outside this change.)
show("wrapperValues", [
  Number.prototype == 0,
  String.prototype == "",
  Boolean.prototype == false,
  Number.prototype.valueOf(),
  Number.prototype.toString(2),
  Number.prototype.toFixed(1),
  String.prototype.valueOf() === "",
  Boolean.prototype.toString(),
  Boolean.prototype.valueOf(),
  Boolean.prototype.toString.call(true),
  Boolean.prototype.valueOf.call(false),
].join("|"));

// A well-known symbol key names no member the table has (every member is a
// string), so a definition under one adds an ordinary property.
Object.defineProperty(Number.prototype, Symbol.replace, {
  get: () => "symbol-member",
  configurable: true,
});
show("symbolKey", [
  Number.prototype[Symbol.replace],
  Object.getOwnPropertySymbols(Number.prototype).length,
  "aXb".split("X").join("|"),
].join("|"));

// The native members still answer the call sites the fence protects.
show("natives", [
  (1.25).toFixed(1),
  (5).toFixed(0),
  "abc".slice(1),
  true.toString(),
  (1n).toString(),
  Symbol().toString(),
  new Date(0).getTime(),
].join("|"));

// A member read off a primitive, off a wrapper instance and off the prototype
// object is one function, as in Node: the wrapper prototypes' members are the
// invoke unit's interned functions, wrapped for the wrapper receivers, and one
// value answers every reader. (A number's or a boolean's methods as values are
// a separate frontend refusal, so the primitives here are strings.)
show("identity", [
  "abc".slice === String.prototype.slice,
  "abc".startsWith === String.prototype.startsWith,
  new String("abc").slice === String.prototype.slice,
  new Number(1).toFixed === Number.prototype.toFixed,
  new Boolean(true).toString === Boolean.prototype.toString,
].join("|"));

for (const line of lines.sort()) console.log(line);
