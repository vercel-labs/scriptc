// Minified `a && b;` / `a || b;` statements whose operands share no value
// representation lower as the control flow they are (jose's secs()), and
// element reads on a RegExpExecArray | null the code ruled non-null
// without narrowing answer undefined for groups that did not participate.
const multipliers = { s: 1, m: 60, h: 3600, d: 86400 };
const REGEX = /^(\+|\-)? ?(\d+|\d+\.\d+) ?(seconds?|s|minutes?|m|hours?|h|days?|d)(?: (ago|from now))?$/i;
function invalid() {
  throw new TypeError("Invalid time period format");
}
function secs(str) {
  typeof str != "string" && invalid();
  const matched = REGEX.exec(str);
  (!matched || matched[4] && matched[1]) && invalid();
  const value = parseFloat(matched[2]);
  const n = Math.round(value * multipliers[matched[3][0].toLowerCase()]);
  return Number.isFinite(n) || invalid(), matched[1] === "-" || matched[4] === "ago" ? -n : n;
}
for (const input of ["10 minutes", "2h", "-1d", "+3 s", "1.5 hours ago", "4 days from now", "-2h ago", "bogus", "", 7]) {
  try {
    console.log(JSON.stringify(input), secs(input));
  } catch (e) {
    console.log(JSON.stringify(input), e.name, e.message);
  }
}

const log = [];
function note(v) {
  log.push(v);
  return v;
}
const values = [0, 1, "", "x", undefined, null, true, false];
for (const v of values) {
  (note(v) || typeof v === "number") && note("and");
  (v && typeof v === "string") || note("or");
  !v || (v === true && note("bool")) || note("rest");
}
console.log(JSON.stringify(log));

const m = /(a)?(b)(c)?/.exec("b");
console.log(m[1], m[2], m[3], m[7], m[1] === undefined, m.length);
const none = /(z)/.exec("b");
console.log(none?.[1], none === null);
