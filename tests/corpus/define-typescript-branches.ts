// @define: process.env.NODE_ENV="production"
// @define: process.env.SCRIPTC_FEATURE="on"
// Conditions `--define` decides in TypeScript: the `if` statement, the right operand of `&&` and `||`, the conditional expression, and a `const` whose initializer is such a comparison. Only the selected code runs, a development-only freeze of an untyped value never does, and a variable the build does not define still follows the environment.
export {};

const DEV = process.env.NODE_ENV !== "production";
const FEATURE = process.env["SCRIPTC_FEATURE"] === "on";

function ran(label: string): boolean {
  console.log("ran " + label);
  return true;
}

class Point {
  x = 1;
  y = 2;
}

const point = new Point();
const held: unknown = point;

if (process.env.NODE_ENV !== "production") {
  Object.freeze(held);
  console.log("development");
} else {
  console.log("production");
}

if (process.env.NODE_ENV === "production" && FEATURE) {
  console.log("production with the feature");
} else {
  Object.seal(held);
}

if (DEV) {
  Object.preventExtensions(held);
} else if (!FEATURE) {
  console.log("no feature");
} else {
  console.log("feature");
}

console.log(DEV && ran("and"), !DEV || ran("or"), FEATURE && ran("feature"));
console.log(process.env.NODE_ENV === "production" ? "minified" : Object.freeze(held));
console.log(DEV ? ran("conditional") : "skipped", FEATURE ? ran("selected") : "skipped");

process.env.SCRIPTC_OTHER = "first";
if (process.env.SCRIPTC_OTHER === "first") {
  console.log("first");
}
process.env.SCRIPTC_OTHER = "second";
console.log(process.env.SCRIPTC_OTHER === "first" ? "first" : "second");
delete process.env.SCRIPTC_OTHER;
console.log(process.env.SCRIPTC_OTHER === undefined || ran("unset"));

point.x = 10;
point.y = point.x + 1;
console.log(point.x, point.y, Object.isFrozen(held), Object.isSealed(held), Object.isExtensible(held));
console.log(process.env.NODE_ENV, process.env.SCRIPTC_FEATURE);
