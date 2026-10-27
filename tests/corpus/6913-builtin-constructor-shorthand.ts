// Builtin constructors in shorthand properties are the constructors themselves.
const direct: Record<string, unknown> = { Date: Date, Map: Map, Set: Set };
const shorthand: Record<string, unknown> = { Date, Map, Set, Object, Promise, WeakMap };
console.log(shorthand.Date === Date, shorthand.Map === direct.Map, shorthand.Set === direct.Set);
console.log(shorthand.Object === Object, shorthand.Promise === Promise, shorthand.WeakMap === WeakMap);
console.log(typeof shorthand.Date, typeof shorthand.Map);
function pick(table: Record<string, unknown>, name: string): unknown {
  return table[name];
}
console.log(pick({ Map, Set }, "Set") === Set, pick({ Date }, "Date") === pick(direct, "Date"));
