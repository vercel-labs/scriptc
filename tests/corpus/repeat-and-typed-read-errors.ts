// "x".repeat with a negative or infinite count and an out-of-range typed
// array read throw catchable RangeErrors: the program keeps running after
// the catch.
function attempt(label: string, f: () => unknown): void {
  try {
    console.log(label, "ok", f());
  } catch (e) {
    if (e instanceof RangeError) console.log(label, "RangeError", e.name, e instanceof Error);
    else console.log(label, "other");
  }
}

const neg: number = process.argv.length > 99 ? 1 : -1;
attempt("repeat-negative", () => "ab".repeat(neg));
attempt("repeat-infinite", () => "ab".repeat(neg / 0 < 0 ? Infinity : 1));
attempt("repeat-ok", () => "ab".repeat(3));

try {
  "x".repeat(neg);
  console.log("not reached");
} catch (e) {
  console.log("message:", (e as Error).message);
}

const bytes = new Uint8Array(4);
bytes[1] = 9;
console.log("in range", bytes[1]);
console.log("after", bytes.length);
