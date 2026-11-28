// A self-append on a frozen record field whose right-hand side passes the
// maximum string length: Node evaluates the right-hand side before the
// assignment's write check, so the catchable RangeError comes first, not the
// frozen write's TypeError. Inline, through a function and through a closure.
const half = "a".repeat(268435445);
console.log(half.length);

function report(label: string, error: unknown): void {
  const e = error as Error;
  console.log(label, e.name, e.message);
}

const inlineRec: { s: string } = { s: half };
Object.freeze(inlineRec);
try {
  inlineRec.s += half + "b";
  console.log("inline built");
} catch (error) {
  report("inline", error);
}

function append(rec: { s: string }): void {
  rec.s += half + "b";
}
const functionalRec: { s: string } = { s: half };
Object.freeze(functionalRec);
try {
  append(functionalRec);
  console.log("functional built");
} catch (error) {
  report("functional", error);
}

const closureRec: { s: string } = { s: half };
Object.freeze(closureRec);
const runClosure = (): void => {
  closureRec.s += half + "b";
};
try {
  runClosure();
  console.log("closure built");
} catch (error) {
  report("closure", error);
}
