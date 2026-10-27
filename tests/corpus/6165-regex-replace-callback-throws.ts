// A replace callback that throws after earlier matches were replaced: the
// partial result is discarded and the exception propagates, with the
// callbacks that ran counted exactly as in Node.
let calls = 0;
function replacer(m: string, digit?: string): string {
  calls++;
  if (digit === "3") throw new RangeError("stop at " + m);
  return "<" + m + ">";
}
for (const subject of ["a1b2c3d4", "x3", "no digits"]) {
  calls = 0;
  try {
    console.log(subject.replace(/(\d)|z/g, replacer), calls);
  } catch (error) {
    console.log(error instanceof RangeError, (error as Error).message, calls);
  }
}
const parts: string[] = [];
for (let i = 0; i < 50; i++) {
  try {
    parts.push(("k" + i + "-3").replace(/(\d)/g, replacer));
  } catch {
    parts.push("thrown");
  }
}
console.log(parts.filter((p) => p === "thrown").length, calls);
