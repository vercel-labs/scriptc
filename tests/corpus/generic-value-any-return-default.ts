// A default parameter whose value is a generic function. That function value
// is a generic declaration read where no instantiation pins it, so its erased
// instance is the one JavaScript has: its parameters and result are checked
// dynamically, and the declaration's `any` result is handed back to the call.
// Node prints the same line.

function id<T>(x: T): any {
  return x;
}

function describe(value: number, transform = id) {
  return `${typeof transform} ${value}`;
}

console.log(describe(7));
