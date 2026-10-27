// Variadic generic wrappers specialize per call site; the forms that have
// no fixed signature or no static name keep precise refusals.
type AnyFn = (...args: any) => any;

// `arguments` with no fixed signature to lower against.
const loose = function () {
  return arguments[0];
};

// `fn.name` where the argument's name is only known at run time.
function named<F extends AnyFn>(fn: F): string {
  return fn.name;
}
function one(): number {
  return 1;
}
function two(): number {
  return 2;
}
const pick = (flag: boolean) => (flag ? one : two);
console.log(named(pick(true)));

// Forwarding a fixed tuple to a variadic function value.
function forward<A extends number[]>(sink: (...xs: number[]) => number, ...args: A): number {
  return sink.apply(null, args);
}
console.log(forward((...xs: number[]) => xs.length, 1, 2));
export { loose };
