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
