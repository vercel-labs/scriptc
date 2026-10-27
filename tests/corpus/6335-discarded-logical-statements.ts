// `a && b;` / `a || b;` statements whose operands share no value
// representation lower as control flow: only the deciding test runs.
function invalid(): never {
  throw new TypeError("invalid");
}
function check(input: string): string {
  const matched = /^(\+|-)?(\d+)(s|m)( ago)?$/.exec(input);
  (!matched || (matched[4] && matched[1])) && invalid();
  return matched ? `${matched[2]}${matched[3]}` : "none";
}
for (const input of ["5s", "-5m", "5m ago", "-5m ago", "x"]) {
  try {
    console.log(input, check(input));
  } catch (e) {
    console.log(input, (e as Error).message);
  }
}
const seen: string[] = [];
function flag(s: string, v: boolean | string | undefined): boolean | string | undefined {
  seen.push(s);
  return v;
}
for (const v of [true, false, "", "y", undefined]) {
  (flag("a", v) || flag("b", v === undefined ? "u" : false)) && seen.push("then");
  (flag("c", v) && flag("d", typeof v === "string")) || seen.push("else");
}
console.log(seen.join(","));
