// DataView.prototype itself as a value: an ordinary object that carries the
// getter/setter family, the buffer/byteLength/byteOffset accessors and the
// constructor, and that carries no [[DataView]] internal slot. A view
// receiver answers the accessors' values, and every other receiver — the
// prototype object included — is the brand check's TypeError.

const view = new DataView(new ArrayBuffer(12), 4, 6);

console.log("type", typeof DataView.prototype, DataView.prototype === DataView.prototype);
console.log("proto-of-proto", Object.getPrototypeOf(DataView.prototype) === Object.prototype);
console.log("constructor", DataView.prototype.constructor === DataView);

// [[@@toStringTag]] is "DataView", non-writable, non-enumerable and
// configurable, so Object.prototype.toString names both the prototype object
// and any view that inherits it.
const tag = Object.getOwnPropertyDescriptor(DataView.prototype, Symbol.toStringTag);
console.log("tag-descriptor", tag.value, tag.writable, tag.enumerable, tag.configurable);

const names = Object.getOwnPropertyNames(DataView.prototype).slice().sort();
console.log("own-keys", names.length, names.slice(0, 4).join(","), names.slice(-3).join(","));

/** The accessor the prototype object carries under `name`. The descriptor's
 * getter is optional to the checker, so the read is narrowed before use. */
function accessor(name) {
  const desc = Object.getOwnPropertyDescriptor(DataView.prototype, name);
  if (!desc || !desc.get) throw new Error("DataView.prototype." + name + " has no getter");
  return desc.get;
}

for (const name of ["buffer", "byteLength", "byteOffset"]) {
  const desc = Object.getOwnPropertyDescriptor(DataView.prototype, name);
  // An accessor function's name is "get " plus the property's name, and its
  // length is zero (it reads the receiver, it takes no argument).
  const getter = accessor(name);
  console.log("getter", name, getter.name, getter.length);
  console.log(
    "descriptor",
    name,
    typeof desc.get,
    desc.set,
    desc.enumerable,
    desc.configurable,
    typeof accessor(name).call(view),
  );
}

// The prototype object carries no [[DataView]] internal slot, so reading its
// accessors — through the property or through the getter — is the brand
// check's TypeError, like any other receiver.
const proto = DataView.prototype;
for (const read of [() => proto.buffer, () => proto.byteLength, () => proto.byteOffset]) {
  try {
    console.log("proto-read", read());
  } catch (e) {
    console.log("proto-read", e.name, e instanceof TypeError);
  }
}
for (const name of ["buffer", "byteLength", "byteOffset"]) {
  try {
    console.log("proto-call", name, accessor(name).call(proto));
  } catch (e) {
    console.log("proto-call", name, e.name, e instanceof TypeError);
  }
}

// On a view the accessors answer what the value's own property reads do.
const bufferGetter = accessor("buffer");
const lengthGetter = accessor("byteLength");
const offsetGetter = accessor("byteOffset");
console.log("view-buffer", bufferGetter.call(view) === view.buffer, bufferGetter.call(view).byteLength);
console.log("view-byteLength", lengthGetter.call(view), lengthGetter.call(view) === view.byteLength);
console.log("view-byteOffset", offsetGetter.call(view), offsetGetter.call(view) === view.byteOffset);

// An own property the program defined on the instance shadows the ordinary
// property read, but the accessors answer the view's internal slots — the
// values the language's [[ViewedArrayBuffer]]/[[ByteLength]]/[[ByteOffset]]
// reads return. The dynamic view of the instance is what the checker allows
// the property definitions and the shadowed reads through.
const shadowed = new DataView(new ArrayBuffer(20), 8, 5);
const shadowedBuffer = shadowed.buffer;
const shadowedDyn = /** @type {any} */ (shadowed);
const shadowedView = /** @type {DataView} */ (shadowedDyn);
Reflect.defineProperty(shadowedDyn, "buffer", { value: "own", configurable: true });
Reflect.defineProperty(shadowedDyn, "byteLength", { value: "own", configurable: true });
Reflect.defineProperty(shadowedDyn, "byteOffset", { value: "own", configurable: true });
console.log("shadowed-read", shadowedDyn.buffer, shadowedDyn.byteLength, shadowedDyn.byteOffset);
console.log("shadowed-buffer", bufferGetter.call(shadowedView) === shadowedBuffer);
console.log("shadowed-byteLength", lengthGetter.call(shadowedView));
console.log("shadowed-byteOffset", offsetGetter.call(shadowedView));

// A subview shares the buffer and keeps its own offset, so the accessors
// follow the view rather than the buffer.
const subview = new DataView(bufferGetter.call(view), 2, 3);
console.log("subview", offsetGetter.call(subview), lengthGetter.call(subview), bufferGetter.call(subview) === view.buffer);

// A foreign receiver is the brand check's TypeError, for every accessor.
for (const receiver of [{}, new Uint8Array(2), 0, "text", null]) {
  try {
    offsetGetter.call(receiver);
    console.log("brand", "no-throw");
  } catch (e) {
    console.log("brand", e.name, e.constructor === TypeError);
  }
}

// The constructor's prototype is the same object, so a constructed view's
// prototype chain reaches it.
console.log("instanceof", new DataView(new ArrayBuffer(1)) instanceof DataView);

// Object.prototype.toString reads the prototype object's own tag. (A view
// itself reports the bytes view's tag: the intrinsic representation of a
// DataView is a u8 view, pinned by the DataView corpus.)
console.log("proto-tag", Object.prototype.toString.call(DataView.prototype));

// The family's members are non-enumerable and configurable, the methods
// writable.
const removed = Object.getOwnPropertyDescriptor(DataView.prototype, "getInt8");
console.log("member-configurable", removed.configurable, removed.writable, removed.enumerable);
