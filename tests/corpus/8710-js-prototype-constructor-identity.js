// A builtin prototype's `constructor` is the constructor the program reads
// (t262-da A2). String, Number, Boolean and BigInt keep their source value as
// the compiler's interned conversion closure, while the prototype object comes
// from the intrinsic table, so reading `X.prototype` installs that closure as
// the prototype's `constructor` — with Node's attributes — and seeds the
// closure's `prototype` with the prototype object. The identity therefore
// holds for a member read, for the property's own descriptor, and for a boxed
// value's `.constructor.prototype` (Object/S9.9_A5 and Object/
// getOwnPropertyDescriptor/15.2.3.3-4-84).
const lines = [];
const show = (name, value) => lines.push(name + "=" + String(value));

const attributes = (target, key) => {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (descriptor === undefined) return "missing";
  return [descriptor.writable, descriptor.enumerable, descriptor.configurable].join("|");
};

// The prototype's own `constructor` is the program's `X`.
show("member", [
  String.prototype.constructor === String,
  Number.prototype.constructor === Number,
  Boolean.prototype.constructor === Boolean,
  BigInt.prototype.constructor === BigInt,
].join("|"));

// The descriptor a program gets reports the same value, so
// `desc.value === X.prototype.constructor` holds as in Node.
show("descriptorValue", [
  Object.getOwnPropertyDescriptor(String.prototype, "constructor").value === String,
  Object.getOwnPropertyDescriptor(Number.prototype, "constructor").value === Number,
  Object.getOwnPropertyDescriptor(Boolean.prototype, "constructor").value === Boolean,
  Object.getOwnPropertyDescriptor(BigInt.prototype, "constructor").value === BigInt,
].join("|"));
show("descriptorReadAgree", [
  Object.getOwnPropertyDescriptor(Boolean.prototype, "constructor").value ===
    Boolean.prototype.constructor,
  Object.getOwnPropertyDescriptor(Number.prototype, "constructor").value ===
    Number.prototype.constructor,
].join("|"));
show("attributes", [
  attributes(String.prototype, "constructor"),
  attributes(Number.prototype, "constructor"),
  attributes(Boolean.prototype, "constructor"),
  attributes(BigInt.prototype, "constructor"),
].join(","));

// The constructor's own `prototype` is that same prototype object, so a boxed
// value's `.constructor.prototype` names the prototype it inherits from.
show("constructorPrototype", [
  String.prototype.constructor.prototype === String.prototype,
  Number.prototype.constructor.prototype === Number.prototype,
  Boolean.prototype.constructor.prototype === Boolean.prototype,
].join("|"));
const boxed = Object("some string");
show("boxed", [
  boxed.constructor === String,
  boxed.constructor.prototype === String.prototype,
  Object.getPrototypeOf(boxed) === String.prototype,
  boxed.valueOf(),
].join("|"));
show("constructed", [
  new Boolean(true).constructor === Boolean,
  Object.getPrototypeOf(new Boolean(true)) === Boolean.prototype,
  new String("xy").valueOf(),
].join("|"));

// The prototype a primitive's wrapper inherits from, the boxed value's
// constructor, and the prototype object itself all name the same objects. (A
// `constructor` read off a primitive literal, `"a".constructor`, is a
// standard library member scriptc refuses by name on the base branch too.)
show("primitive", [
  Object.getPrototypeOf("a") === String.prototype,
  Object.getPrototypeOf(1) === Number.prototype,
  Object.getPrototypeOf(true) === Boolean.prototype,
  Object("a").constructor === String,
].join("|"));

// The prototype object is still the wrapper value the table answered before:
// `constructor` is one ordinary own member among its keys.
show("ownKey", [
  Object.getOwnPropertyNames(String.prototype).includes("constructor"),
  Object.getOwnPropertyNames(Boolean.prototype).includes("constructor"),
  String.prototype === String.prototype,
  typeof String.prototype,
  Boolean.prototype.valueOf(),
].join("|"));

// A read of the prototype before and after another intrinsic's read answers
// the same object and the same constructor.
const beforeBoolean = Boolean.prototype;
const other = BigInt.prototype;
show("stable", [
  beforeBoolean === Boolean.prototype,
  other === BigInt.prototype,
  Boolean.prototype.constructor === Boolean,
  beforeBoolean.constructor === Boolean,
].join("|"));

for (const line of lines.sort()) console.log(line);
