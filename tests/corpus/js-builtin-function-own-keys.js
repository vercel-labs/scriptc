// A lib-declared builtin function global has exactly `length` and `name` as
// own keys, the two Object.prototype own-key probes answer from that set, and
// `toString` tags it as a function. Reading the global in a value position
// lowers as that interned value, so the probes lower instead of refusing.
console.log(
  Object.prototype.hasOwnProperty.call(parseInt, "length"),
  Object.prototype.hasOwnProperty.call(parseInt, "name"),
  Object.prototype.hasOwnProperty.call(parseInt, "prototype"),
  Object.prototype.propertyIsEnumerable.call(parseInt, "name"),
  Object.prototype.toString.call(parseInt),
);
console.log(
  Object.prototype.hasOwnProperty.call(parseFloat, "name"),
  Object.prototype.hasOwnProperty.call(isNaN, "prototype"),
  Object.prototype.propertyIsEnumerable.call(isFinite, "length"),
  Object.prototype.toString.call(decodeURI),
  Object.prototype.toString.call(encodeURI),
);

// The value is callable and carries its documented name and length.
console.log(parseInt("0x1f", 16), parseInt.length, parseInt.name, isNaN.length, isNaN.name);
console.log(Object.prototype.hasOwnProperty.call(parseInt, "fromCodePoint"));
console.log(Object.prototype.hasOwnProperty.call(Math, "PI"));

// The negative side of the probes reads as false, not as an error.
console.log(Object.prototype.propertyIsEnumerable.call(parseInt, "length"));
console.log(Object.prototype.hasOwnProperty.call(parseInt, "caller"));
