// `let` bindings initialized with a string, number or boolean and later
// assigned values that can be null or undefined. JavaScript files are
// checked without strict null checks, so the declared type of each binding
// is the primitive alone.
const PATTERN = /^(\d+)(?:\.(\d+))?([+-]\d\d:\d\d)?$/;
function parts(text) {
  let offset = "Z";
  let fraction = 0;
  let signed = false;
  const match = text.match(PATTERN);
  if (match) {
    offset = match[3] || null;
    fraction = match[2] ? +match[2] : undefined;
    signed = match[3] ? match[3][0] === "-" : null;
  }
  return [offset, fraction, signed];
}
console.log(parts("12"), parts("12.5"), parts("12.25-01:00"), parts("x"));

function pick(flag) {
  let name = "default";
  name = flag ? name.toUpperCase() : void 0;
  let count = 1;
  count = flag && count + 1;
  let ready = true;
  ready = flag === undefined ? undefined : !flag;
  return [name, count, ready, typeof name, typeof count];
}
console.log(pick(true), pick(false), pick(undefined));

let last = "start";
const seen = [];
for (const value of ["a", null, "b", undefined]) {
  last = value ?? null;
  seen.push(last === null ? "null" : last.length);
}
console.log(seen, last);
