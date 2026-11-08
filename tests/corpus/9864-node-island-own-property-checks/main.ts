// @requires-libnode
// Own-property checks on an object a Node island made are answered by Node:
// `Object.hasOwn`, `hasOwnProperty` and `propertyIsEnumerable` with a string
// key, for a value the program asserts a type for, for one the island's own
// declarations type, and for an untyped one. A member that holds undefined
// is the object's own, an absent optional member is not, a member that is
// not enumerable is its own all the same, and an accessor of the class is
// inherited. The island's later changes show in the next answer. A record
// the program builds under the same type answers as it always did.
import { packet, relabel, typedPacket } from "seed-kit";

interface Label {
  variety?: string;
  note?: string;
  sowBy?: string;
}

const names = ["variety", "note", "sowBy", "lot", "shelfLife"];
function own(value: object): string {
  return names.map((name) => `${name}:${Object.hasOwn(value, name)}`).join(" ");
}
function listed(value: object): string {
  return names
    .map((name) => `${name}:${Object.prototype.propertyIsEnumerable.call(value, name)}`)
    .join(" ");
}

// A type the program asserts: a view of the island's object.
const asserted = packet("pea") as Label;
console.log(own(asserted));
console.log(listed(asserted));
console.log(
  Object.hasOwn(asserted, "note"),
  Object.hasOwn(asserted, "sowBy"),
  Object.prototype.hasOwnProperty.call(asserted, "variety"),
  asserted.hasOwnProperty("lot"),
  asserted.propertyIsEnumerable("lot"),
);
relabel(asserted);
console.log(own(asserted));
console.log(Object.hasOwn(asserted, "variety"), Object.hasOwn(asserted, "sowBy"), asserted.sowBy);

// The island's own declarations.
const typed = typedPacket("bean");
console.log(own(typed));
console.log(listed(typed));
console.log(Object.hasOwn(typed, "note"), Object.hasOwn(typed, "shelfLife"), typed.shelfLife);

// An untyped island value.
const untyped = packet("leek");
console.log(Object.hasOwn(untyped as object, "variety"), Object.hasOwn(untyped as object, "sowBy"));

// A record the program builds under the asserted type.
const mine: Label = { variety: "kale" };
console.log(own(mine), listed(mine));
