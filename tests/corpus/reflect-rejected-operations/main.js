// Reflect.defineProperty answers false where Object.defineProperty throws for
// a rejected definition, and Reflect.setPrototypeOf answers false for the
// changes Object.setPrototypeOf throws for. Both still throw for the errors
// Node throws (an invalid descriptor, a primitive prototype).

const frozen = Object.freeze({ a: 1 });
console.log(Reflect.defineProperty(frozen, 'a', { value: 2 }));
console.log(Reflect.defineProperty(frozen, 'b', { value: 2 }));

const locked = {};
Object.defineProperty(locked, 'x', { value: 1, configurable: false });
console.log(Reflect.defineProperty(locked, 'x', { value: 2 }));
console.log(Reflect.defineProperty(locked, 'x', { value: 1 }));
console.log(Reflect.defineProperty({}, 'y', { value: 1 }));

try {
  Reflect.defineProperty({}, 'z', null);
} catch (error) {
  console.log('descriptor', error.name);
}

const target = Object.preventExtensions({});
try {
  Reflect.setPrototypeOf(target, 1);
} catch (error) {
  console.log('primitive prototype', error.name);
}

const a = {};
const b = Object.create(a);
console.log(Reflect.setPrototypeOf(a, b));
console.log(Reflect.setPrototypeOf(a, a));

const base = { p: 1 };
console.log(Reflect.setPrototypeOf({}, base));
const same = Object.create(base);
console.log(Reflect.setPrototypeOf(Object.preventExtensions(same), base));
console.log(Reflect.setPrototypeOf(Object.preventExtensions({}), base));

try {
  Reflect.setPrototypeOf(Object.preventExtensions({}), 'x');
} catch (error) {
  console.log('primitive on non-extensible', error.name);
}

// A typed array element: an invalid index and any descriptor that is not a
// plain writable data descriptor are rejected with false.
const bytes = () => new Uint8Array(2);
console.log(Reflect.defineProperty(bytes(), 0, { value: 5 }));
console.log(Reflect.defineProperty(bytes(), 0, { value: 5, writable: false }));
console.log(Reflect.defineProperty(bytes(), 0, { value: 5, configurable: false }));
console.log(Reflect.defineProperty(bytes(), 0, { value: 5, enumerable: false }));
console.log(Reflect.defineProperty(bytes(), 0, { get() { return 1; } }));
console.log(Reflect.defineProperty(bytes(), 5, { value: 5 }));
console.log(Reflect.defineProperty(bytes(), 1.5, { value: 5 }));
console.log(Reflect.defineProperty(bytes(), -1, { value: 5 }));
console.log(Reflect.defineProperty(bytes(), 'x', { value: 5 }));
