// A function with fixed parameters stored where a variadic function type is
// expected: each call passes the arguments in order, and the parameters the
// function does not declare are evaluated and dropped.
const one = (a: unknown) => {
  console.log("one", String(a));
};
const oneAsRest: (...args: unknown[]) => void = one;
oneAsRest("x", "y", "z");

const two = (a: string, b: number) => {
  console.log("two", a, b);
};
const twoAsRest: (...args: any[]) => void = two;
twoAsRest("n", 5, true);

const store: ((...args: unknown[]) => void)[] = [oneAsRest];
store[0]!("p", 1);

const order: string[] = [];
const note = (s: string): string => {
  order.push(s);
  return s;
};
oneAsRest(note("first"), note("second"), note("third"));
console.log(order.join(","));
