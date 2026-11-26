// A variadic function stored under a narrower callback type, handed to an
// array method: the method's JavaScript call passes the element, its index
// and the array, and the stored function observes all of them.
const counter = (...args: unknown[]) => args.length;
const one: (x: number) => number = counter;
console.log([3, 1, 2].map(one).join(","));

const wide: (x: number, i: number) => number = counter;
console.log([3, 1, 2].map(wide).join(","));
console.log([3, 1, 2].filter(one).join(","));
console.log([3, 1, 2].some(one) ? "some" : "none");
console.log([3, 1, 2].findIndex(one));
