// Typed uses of the declared globals from another module: the checker's
// declared type is what each use site asks the checked-dynamic value for.
export function report(): void {
  const weights: number[] = flags.map((flag) => (flag ? 1 : 0));
  console.log(counter / 2, weights.join("-"), typeof counter);
  const el = document.getElementById("y");
  console.log(el === null ? "none" : el.id);
  console.log("declare const counters as " + counter);
}
