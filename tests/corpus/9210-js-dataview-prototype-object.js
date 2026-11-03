// DataView.prototype itself as a value: an ordinary object that carries the
// getter/setter family, the buffer/byteLength/byteOffset accessors and the
// constructor, with the prototype object's own internal slots holding no
// buffer. Its accessors answer the slots it carries (undefined, 0, 0), a
// DataView receiver answers its own buffer's values, and any other receiver
// is the brand check's TypeError.

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

for (const name of ["buffer", "byteLength", "byteOffset"]) {
  const desc = Object.getOwnPropertyDescriptor(DataView.prototype, name);
  console.log(
    "descriptor",
    name,
    typeof desc.get,
    desc.set,
    desc.enumerable,
    desc.configurable,
    typeof desc.get.call(view),
  );
}

// On the prototype object itself the slots answer no buffer and a zero
// length and offset.
console.log("proto-buffer", DataView.prototype.buffer);
console.log("proto-byteLength", DataView.prototype.byteLength);
console.log("proto-byteOffset", DataView.prototype.byteOffset);

// On a view the accessors answer what the value's own property reads do.
const bufferGetter = Object.getOwnPropertyDescriptor(DataView.prototype, "buffer").get;
const lengthGetter = Object.getOwnPropertyDescriptor(DataView.prototype, "byteLength").get;
const offsetGetter = Object.getOwnPropertyDescriptor(DataView.prototype, "byteOffset").get;
console.log("view-buffer", bufferGetter.call(view) === view.buffer, bufferGetter.call(view).byteLength);
console.log("view-byteLength", lengthGetter.call(view), lengthGetter.call(view) === view.byteLength);
console.log("view-byteOffset", offsetGetter.call(view), offsetGetter.call(view) === view.byteOffset);

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

// Object.prototype.toString uses the tag, not the missing Symbol.toStringTag
// accessor, for a DataView value.
console.log("tag", Object.prototype.toString.call(view));
console.log("proto-tag", Object.prototype.toString.call(DataView.prototype));

// Removing an own member from the fresh object (the object is rebuilt per
// program, so this only pins that the property is configurable).
const removed = Object.getOwnPropertyDescriptor(DataView.prototype, "getInt8");
console.log("member-configurable", removed.configurable, removed.writable, removed.enumerable);
