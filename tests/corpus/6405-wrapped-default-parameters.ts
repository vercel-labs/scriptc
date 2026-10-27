// Lambdas whose parameters take their type from an `any` default, passed
// through generic wrappers that forward their arguments.
function trace<F extends (...args: any[]) => any>(name: string, fn: F): F {
  return ((...args: Parameters<F>) => {
    console.log("span", name);
    return fn(...args);
  }) as F;
}
function traceArgs<A extends unknown[], R>(name: string, fn: (...args: A) => R): (...args: A) => R {
  return (...args: A) => {
    console.log("span", name);
    return fn(...args);
  };
}
function lookup(key: string): any {
  return key === "set" ? 7 : undefined;
}

const doubled = trace("doubled", (n = lookup("unset") ?? 5) => n * 2);
console.log(doubled(), doubled(4));
const sum = trace("sum", (n = lookup("set") ?? 5, m = 1) => n * 4 + m);
console.log(sum(), sum(2), sum(2, 3));
const label = trace("label", (prefix = lookup("unset") ?? "item", count: number = 0) => `${prefix}#${count}`);
console.log(label(), label("row"), label(undefined, 3));
const tripled = traceArgs("tripled", (n: number = lookup("unset") ?? 5) => n * 3);
console.log(tripled(), tripled(2));

// A wrapper that also reports tags computed from the wrapped function's
// result, handing its untyped result on through `as never`.
function traceTagged<F extends (...args: any[]) => any>(
  name: string,
  fn: F,
  resultTags?: (
    result: ReturnType<F> extends PromiseLike<infer U> ? U : ReturnType<F>,
  ) => Record<string, unknown>,
): F {
  return ((...args: Parameters<F>) => {
    const result: unknown = fn(...args);
    if (resultTags) console.log(name, JSON.stringify(resultTags(result as never)));
    return result;
  }) as F;
}
const summarize = traceTagged(
  "summarize",
  (limit = lookup("unset") ?? 2) => ({ kept: Number(limit), dropped: 1 }),
  (r) => ({ total: r.kept + r.dropped }),
);
console.log(summarize().kept, summarize(5).kept);

// The same through a function expression whose result is untyped.
function traceTaggedAny<F extends (...args: any[]) => any>(
  name: string,
  fn: F,
  resultTags: (result: ReturnType<F>) => Record<string, unknown>,
): F {
  return function (this: unknown, ...args: Parameters<F>) {
    const result = fn.apply(this, args);
    console.log(name, JSON.stringify(resultTags(result as never)));
    return result;
  } as F;
}
const measure = traceTaggedAny(
  "measure",
  (width = lookup("set") ?? 1, height = 2) => ({ area: Number(width) * height }),
  (r) => ({ area: r.area }),
);
console.log(measure().area, measure(3, 4).area);
