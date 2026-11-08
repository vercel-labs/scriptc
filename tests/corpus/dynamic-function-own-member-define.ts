// A checked-dynamic value may hold an any-typed function, so a definition
// through it names a receiver the compiler cannot prove is not a function:
// the program links the runtime build that creates the own property instead
// of refusing the write.
const fn: any = function (this: any): number {
  return 1;
};
Object.defineProperty(fn, "call", { value: 42, configurable: true, writable: true });
console.log("define", fn.call, typeof fn);

// The same through a parameter of any type: the target is a function only at
// run time.
function label(target: any): string {
  Object.defineProperty(target, "bind", { value: "own", configurable: true, writable: true });
  return String(target.bind);
}
console.log(
  "param",
  label(function (): number {
    return 2;
  }),
);
