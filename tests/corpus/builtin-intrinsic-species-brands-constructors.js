// The intrinsic graph's members answer what the language defines. A species
// getter answers its receiver, whatever it is — the constructor, a number, an
// undefined receiver — instead of refusing a receiver that carries no slot.
// A slot accessor reads its own receiver's internal slot: a Map's `size`
// getter reads a Map, not a Set that happens to surface a `size` member of its
// own, and a DataView's `byteLength` getter reads a view, not a typed array.
// A member a plain object inherits from the filled Object.prototype reads
// through that object's property table. And a prototype's `constructor` is
// the function the program's global name answers.

/** The getter `owner` carries under `key`, or undefined when it carries
 * none. */
function getterOf(owner, key) {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  return descriptor === undefined ? undefined : descriptor.get;
}

/** What `getter` answers for `receiver`: a function's name, the value as
 * text, or the thrown error's name. */
function show(getter, receiver) {
  try {
    const value = Reflect.apply(getter, receiver, []);
    return typeof value === "function" ? value.name : String(value);
  } catch (e) {
    return e.name;
  }
}

// [[@@species]] answers the receiver it was called on, whatever the receiver
// is: the getter a constructor links is called on that constructor, and a
// program that calls it on `1` or on `undefined` reads those values back.
const mapSpecies = getterOf(Map.prototype.constructor, Symbol.species);
const setSpecies = getterOf(Set.prototype.constructor, Symbol.species);
const regexpSpecies = getterOf(RegExp.prototype.constructor, Symbol.species);
const bufferSpecies = getterOf(ArrayBuffer.prototype.constructor, Symbol.species);
const promiseSpecies = getterOf(Promise.prototype.constructor, Symbol.species);
console.log("species", show(mapSpecies, Map), show(mapSpecies, 1), show(mapSpecies, undefined));
console.log(
  "species-rest",
  show(setSpecies, Set),
  show(regexpSpecies, RegExp),
  show(bufferSpecies, ArrayBuffer),
  show(promiseSpecies, Promise),
);

// The `size` getters are defined over their own kind's internal slot. A Set
// answers a `size` member of its own, but the Map getter reads a Map's
// [[MapData]] and a Set receiver is the incompatible receiver, and the other
// way round.
const map = new Map();
map.set(1, 2);
const set = new Set();
set.add(1);
const mapSize = getterOf(Map.prototype, "size");
const setSize = getterOf(Set.prototype, "size");
console.log("size", show(mapSize, map), show(mapSize, set), show(setSize, set), show(setSize, map));

// The same for a DataView's accessors: the view's [[DataView]] slot is what
// answers, and neither a plain object nor a typed array carries one.
const byteLength = getterOf(DataView.prototype, "byteLength");
console.log(
  "dataview",
  show(byteLength, new DataView(new ArrayBuffer(4))),
  show(byteLength, {}),
  show(byteLength, new Uint8Array(2)),
);

// Object.prototype is filled in place with the graph's members, and a plain
// object inherits them: the read walks the filled prototype's own table
// rather than stopping at it. A member the program adds to the prototype is
// inherited the same way, by a plain object and by an array; the read names
// the key with a variable so it takes the runtime's own-member walk rather
// than the read a checked record's declared member gets.
Object.prototype.added = 7;
const plain = {};
const addedKey = "added";
console.log(
  "inherited",
  typeof plain.hasOwnProperty,
  plain.hasOwnProperty === Object.prototype.hasOwnProperty,
  plain.hasOwnProperty("x"),
  plain.toString === Object.prototype.toString,
  typeof plain.valueOf,
);
console.log("added", plain[addedKey], "added" in plain, [].added);

// A prototype's constructor is the function the global name answers, so the
// graph's link and the program's name are one value.
console.log(
  "constructor",
  ArrayBuffer.prototype.constructor === ArrayBuffer,
  Uint8Array.prototype.constructor === Uint8Array,
  Float64Array.prototype.constructor === Float64Array,
);
