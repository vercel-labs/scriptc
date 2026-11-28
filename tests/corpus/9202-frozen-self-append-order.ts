// A self-append on a frozen array's string element that would also pass the
// maximum string length: Node evaluates the right-hand side before the
// assignment, so the catchable RangeError comes first, not the frozen write's
// TypeError. The writable array beside it reports the same RangeError.
const half = "a".repeat(268435445);
console.log(half.length);

function attempt(label: string, arr: string[]): void {
  try {
    arr[0] += half + "b";
    console.log(label, "built", arr[0]!.length);
  } catch (error) {
    const e = error as Error;
    console.log(label, e.name, e.message);
  }
}

const writable = [half, "x"];
attempt("writable", writable);
const frozen = [half, "x"];
Object.freeze(frozen);
attempt("frozen", frozen);
