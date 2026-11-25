// A generic function whose parameter is `T | A | B` for classes A and B
// removes those classes with `instanceof` and returns what is left as T.
// When the argument's union holds several other parts, T stands for all of
// them: the value returned is the one that came in.
class Expired extends Error {
  days = 3;
}
class Revoked extends Error {
  by = "admin";
}
class Suspended extends Error {
  until = "monday";
}
type Pass = { holder: string; zones: number };

function admit<T>(entry: T | Expired | Revoked): T | "refused" {
  if (entry instanceof Expired) return "refused";
  if (entry instanceof Revoked) return "refused";
  return entry;
}

// T is a record and null.
function scan(code: number): Expired | Revoked | Pass | null {
  if (code === 1) return new Expired("pass expired");
  if (code === 2) return new Revoked("pass revoked");
  if (code === 3) return null;
  return { holder: "ada", zones: code };
}
for (const code of [0, 1, 2, 3, 5]) {
  const result = admit(scan(code));
  if (result === "refused") console.log("refused");
  else if (result === null) console.log("no pass");
  else console.log("pass", result.holder, result.zones);
}

// T keeps a class the filter does not test, beside a record: the instance
// that comes out is the instance that went in.
const suspended = new Suspended("pass suspended");
function scanStaff(code: number): Expired | Suspended | Pass {
  if (code === 1) return new Expired("badge expired");
  if (code === 2) return suspended;
  return { holder: "grace", zones: 9 };
}
for (const code of [0, 1, 2]) {
  const result = admit(scanStaff(code));
  if (result === "refused") console.log("refused");
  else if (result instanceof Suspended) console.log("suspended", result.until, result === suspended);
  else console.log("staff", result.holder, result.zones);
}

// T is a string and a number, and the filter tests one class.
function settle<T>(value: T | Expired): T | undefined {
  if (value instanceof Expired) return undefined;
  return value;
}
function reading(n: number): Expired | string | number {
  if (n === 0) return new Expired("meter expired");
  if (n === 1) return "offline";
  return n * 1.5;
}
for (const n of [0, 1, 4]) {
  const left = settle(reading(n));
  console.log(left === undefined ? "dropped" : typeof left === "number" ? left + 1 : left.length);
}

// T is one part: the binding main already made.
function single(n: number): Expired | Pass {
  return n === 0 ? new Expired("gone") : { holder: "lin", zones: n };
}
for (const n of [0, 2]) {
  const left = settle(single(n));
  console.log(left === undefined ? "dropped" : left.holder);
}
