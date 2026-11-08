// `instanceof` against a built-in class that has no run-time class test is
// refused by the class's name, with what a program can test instead.
function describe(value: unknown): string {
  if (value instanceof AbortController) return "controller";
  if (value instanceof WeakRef) return "reference";
  return "other";
}
console.log(describe(new AbortController()), describe({}));
