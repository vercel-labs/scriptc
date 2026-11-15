"use strict";
// DataView.prototype's byteLength and byteOffset accessors, called through
// the descriptor's getter, on a view whose buffer moved under it: a view over
// a buffer that shrank below it, or over a detached one, throws the same
// TypeError the property read throws, and a length-tracking view follows a
// buffer that grew. The accessors once answered 0 for the unusable views.
function accessor(name) {
  const desc = Object.getOwnPropertyDescriptor(DataView.prototype, name);
  if (!desc || !desc.get) throw new Error("no getter " + name);
  return desc.get;
}
const buffer = new ArrayBuffer(8, { maxByteLength: 16 });
const view = new DataView(buffer, 4, 4);
const tracking = new DataView(buffer, 4);
const byteLength = accessor("byteLength");
const byteOffset = accessor("byteOffset");
console.log("before", byteLength.call(view), byteOffset.call(view), byteLength.call(tracking));
buffer.resize(12);
console.log("grown", byteLength.call(view), byteLength.call(tracking));
buffer.resize(2);
try {
  console.log("fixed byteLength", byteLength.call(view));
} catch (e) {
  console.log("fixed byteLength", e.constructor.name, e.message);
}
try {
  console.log("fixed byteOffset", byteOffset.call(view));
} catch (e) {
  console.log("fixed byteOffset", e.constructor.name, e.message);
}
try {
  console.log("tracking byteLength", byteLength.call(tracking));
} catch (e) {
  console.log("tracking byteLength", e.constructor.name, e.message);
}
try {
  console.log("tracking byteOffset", byteOffset.call(tracking));
} catch (e) {
  console.log("tracking byteOffset", e.constructor.name, e.message);
}
try {
  console.log("direct", view.byteLength);
} catch (e) {
  console.log("direct", e.constructor.name, e.message);
}
const detached = new ArrayBuffer(8);
const over = new DataView(detached, 2, 4);
detached.transfer();
try {
  console.log("detached byteLength", byteLength.call(over));
} catch (e) {
  console.log("detached byteLength", e.constructor.name, e.message);
}
try {
  console.log("detached byteOffset", byteOffset.call(over));
} catch (e) {
  console.log("detached byteOffset", e.constructor.name, e.message);
}
