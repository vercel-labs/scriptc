// Nested variadic wrappers: wrapping an already wrapped function, mixing
// the `arguments` form and the rest-tuple form. The inner wrapper's
// function binding gives the outer wrapper its `fn.name`.
type AnyFn = (...args: any) => any;

function trace<F extends AnyFn>(fn: F, label?: string): F {
  const wrapped = function (this: unknown) {
    console.log("trace>", label ?? fn.name);
    const out = fn.apply(this, arguments as any);
    console.log("trace<", label ?? fn.name);
    return out;
  };
  return wrapped as unknown as F;
}

function timed<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return function (this: unknown, ...args: A): R {
    console.log("timed>", fn.name, args.length);
    return fn.apply(this, args);
  };
}

function area(w: number, h: number): number {
  return w * h;
}

const twice = trace(trace(area));
console.log(twice(2, 3));

const labelled = trace(trace(area, "inner"), "outer");
console.log(labelled(4, 5));

const mixed = timed(trace(area));
console.log(mixed(6, 7));

const mixed2 = trace(timed(area));
console.log(mixed2(1, 9));
