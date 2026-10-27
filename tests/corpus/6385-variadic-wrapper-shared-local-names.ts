// Variadic wrappers whose bodies declare the same local names: one only
// forwards its `arguments` (or its alias of them), the other also reads an
// element, so its tuple exists. Each wrapper forwards its own arguments, also
// when a block-local alias shadows an outer one in the same function.
type AnyFn = (...args: any) => any;

function forward<F extends AnyFn>(fn: F): F {
  return function (this: unknown) {
    return fn.apply(this, arguments as any);
  } as F;
}

function logFirst<F extends AnyFn>(fn: F): F {
  return function (this: unknown) {
    console.log("first:", arguments[0], "of", arguments.length);
    return fn.apply(this, arguments as any);
  } as F;
}

function forwardAlias<F extends AnyFn>(fn: F): F {
  return function (this: unknown) {
    const args = arguments as any;
    return fn.apply(this, args);
  } as F;
}

function logFirstAlias<F extends AnyFn>(fn: F): F {
  return function (this: unknown) {
    const args = arguments as any;
    console.log("alias first:", args[0]);
    return fn.apply(this, args);
  } as F;
}

function shadowed<F extends AnyFn>(fn: F): F {
  return function (this: unknown) {
    const args = arguments as any;
    console.log("outer first:", args[0]);
    if (args.length > 1) {
      const args = arguments as any;
      return fn.apply(this, args);
    }
    return fn.apply(this, args);
  } as F;
}

function add3(a: number, b: number, c: number): number {
  return a + b + c;
}

function greet(name: string): string {
  return "hi " + name;
}

const sum = forward(add3);
console.log(sum(1, 2, 3));
const hello = logFirst(greet);
console.log(hello("ada"));

const sumAlias = forwardAlias(add3);
console.log(sumAlias(4, 5, 6));
const helloAlias = logFirstAlias(greet);
console.log(helloAlias("grace"));

// The other order: the wrapper that reads an element first.
const hello2 = logFirst(greet);
console.log(hello2("linus"));
const sum2 = forward(add3);
console.log(sum2(7, 8, 9));

// A block-local alias with the same name as the outer one.
const sumShadowed = shadowed(add3);
console.log(sumShadowed(10, 20, 30));
const helloShadowed = shadowed(greet);
console.log(helloShadowed("ken"));
