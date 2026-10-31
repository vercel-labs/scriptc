// Reflection over the namespace objects answers Node's property
// attributes: members are own, non-enumerable properties, the Math
// constants are read-only, and Symbol.toStringTag names the namespace.
function show(object, key) {
  const d = Object.getOwnPropertyDescriptor(object, key);
  if (d === undefined) return `${String(key)}: none`;
  const value = typeof d.value === "function" ? `fn/${d.value.length}/${d.value.name}` : String(d.value);
  return `${String(key)}: ${value} ${d.writable} ${d.enumerable} ${d.configurable}`;
}
function inspect(object) {
  return [
    Object.hasOwn(object, "parse"),
    Object.hasOwn(object, "abs"),
    Object.keys(object).length,
    Object.getOwnPropertyNames(object).length,
  ].join(" ");
}
console.log(show(Math, "abs"), "|", show(Math, "PI"), "|", show(Math, "max"));
console.log(show(Math, Symbol.toStringTag), "|", show(JSON, "stringify"), "|", show(Reflect, "apply"));
console.log(inspect(Math), "|", inspect(JSON), "|", inspect(Reflect));
console.log(Object.getOwnPropertyNames(JSON).join(","));
console.log(Object.getOwnPropertyNames(Math).slice(0, 5).join(","), Object.getOwnPropertyNames(Math).at(-1));
console.log(Object.prototype.hasOwnProperty.call(Math, "random"), Object.keys(Reflect).length);
