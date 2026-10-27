// @disallow-code-generation
// eval and the Function constructor throw Node's EvalError, exactly as
// under node --disallow-code-generation-from-strings (the harness runs the
// Node oracle with that flag): catchable, at call time, after the
// arguments evaluate. The Function constructor converts its arguments to
// strings before it refuses; eval refuses without converting.
const log: string[] = [];
const arg = (text: string): string => {
  log.push(text);
  return text;
};

let allowsEval = true;
try {
  new Function("");
} catch (e) {
  allowsEval = false;
  const err = e as Error;
  console.log(err.name, err.message, err instanceof EvalError, err instanceof Error);
}
console.log("allowsEval", allowsEval);

try {
  eval(arg("1 + 1"));
} catch (e) {
  log.push((e as Error).name);
}
try {
  Function(arg("a"), arg("return a"));
} catch (e) {
  log.push((e as Error).name);
}
try {
  (0, eval)(arg("2"));
} catch (e) {
  log.push((e as Error).name);
}
try {
  globalThis.eval(arg("3"));
} catch (e) {
  log.push((e as Error).name);
}
console.log(log.join(","));
console.log(typeof eval, typeof Function);
