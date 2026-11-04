// A checked-dynamic receiver's array helper called with a callback whose
// parameters are NARROWER than the dyn element it passes: `.filter((m):
// m is string => ...)` (and any annotated narrower parameter) after a
// `.map(...)` the frontend lowers to the checked-dynamic array. The
// callback stays a value with the checker's parameter types and each
// argument crosses the dyn boundary into them with the usual checked
// conversion. Node-exact output for every element shape.
function collect(errors: unknown): string {
  if (Array.isArray(errors)) {
    const messages = errors
      .map((error) => (typeof error === "string" ? error : undefined))
      .filter((message): message is string => message !== undefined);
    if (messages.length > 0) return messages.join("; ");
  }
  return "none";
}

function narrowAfterMap(values: unknown[]): string[] {
  const widths = values
    .map((value) => (typeof value === "number" ? value : undefined))
    .filter((width): width is number => width !== undefined);
  return widths.map((width) => `${width}px`);
}

function truthyObjects(values: unknown[]): number {
  const kept = values
    .map((value) => (value === null || value === undefined ? null : value))
    .filter((value): value is object => value !== null)
    .filter((value) => Object.keys(value).length > 0);
  return kept.length;
}

console.log("messages:", collect([{ message: "a" }, "b", { message: "c" }]));
console.log("messages:", collect(["only"]));
console.log("messages:", collect([{ message: "x" }, { message: "y" }]));
console.log("messages:", collect([]));
console.log("messages:", collect("not an array"));
console.log("widths:", narrowAfterMap([10, "20", 30, null]).join(" | "));
console.log("widths:", narrowAfterMap([]).join(" | "));
console.log("objects:", truthyObjects([{ a: 1 }, {}, null, undefined, { b: 2 }]));
