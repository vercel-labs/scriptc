// A function whose signature cannot compile: its body's statements count
// toward the total as not static, so the percentage reflects them.
function applyAll(f: <T>(x: T) => T, n: number): number {
  const doubled = n * 2;
  if (doubled > 4) {
    return f(doubled);
  }
  return doubled;
}
console.log(typeof applyAll);
console.log("static");
