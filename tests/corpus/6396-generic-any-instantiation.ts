// A generic method instantiated at `any` from an untyped forwarding call.
type AnyFn = (...args: any) => any;
class Tracer {
  trace<T>(name: string, fn: () => T): T {
    console.log("span", name);
    return fn();
  }
}
const tracer = new Tracer();
function traced<F extends AnyFn>(name: string, fn: F): F {
  return function (this: unknown) {
    const args = arguments;
    const result = tracer.trace(name, () => fn.apply(this, args as any));
    return result;
  } as F;
}
const add = traced("add", (a: number, b: number) => a + b);
console.log(add(1, 2));
