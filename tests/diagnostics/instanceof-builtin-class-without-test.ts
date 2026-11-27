// `instanceof` against a built-in class that has no run-time class test is
// refused by the class's name, with what a program can test instead.
function describe(value: unknown): string {
  if (value instanceof Iterator) return "iterator";
  if (value instanceof MessagePort) return "port";
  return "other";
}
console.log(describe({}), describe({}));
