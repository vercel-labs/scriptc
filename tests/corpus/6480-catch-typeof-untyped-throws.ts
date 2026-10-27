// Values thrown from `unknown` storage read back through typeof tests on
// the catch binding, like the same values thrown with static types.
const thrown: unknown[] = [5, 0, -1.5, "text", "", true, false, null, undefined, { kind: "box" }];
function describe(value: unknown): string {
  try {
    throw value;
  } catch (e) {
    const same = e === value;
    if (typeof e === "number") return `${same} number ${e + 1}`;
    if (typeof e === "string") return `${same} string ${e.length}`;
    if (typeof e === "boolean") return `${same} boolean ${!e}`;
    if (typeof e === "object") return `${same} object ${e === null ? "null" : "value"}`;
    return `${same} ${typeof e}`;
  }
}
for (const value of thrown) console.log(describe(value));
function rethrow(value: unknown): void {
  try {
    throw value;
  } catch (e) {
    if (typeof e !== "string") throw e;
    console.log("kept string", e);
  }
}
for (const value of ["s", 7, false]) {
  try {
    rethrow(value);
  } catch (e) {
    console.log("rethrown", typeof e, String(e));
  }
}
let count = 0;
for (const value of thrown) {
  try {
    throw value;
  } catch (e) {
    if (typeof e === "number" && e > 0) count += e;
  }
}
console.log(count);
