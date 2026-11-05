// A function whose signature cannot compile (`Intl.NumberFormat` has no
// scriptc lowering, and no erasure to a dynamic closure covers it): its
// body's statements count toward the total as not static, so the
// percentage reflects them.
function applyAll(target: Intl.NumberFormat, n: number): number {
  const doubled = n * 2;
  if (doubled > 4) {
    return target == undefined ? 0 : doubled;
  }
  return doubled;
}
console.log(typeof applyAll);
console.log("static");
