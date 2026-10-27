// Function.prototype as a value: a callable answering undefined, with an
// empty name and length 0, usable as a prototype-chain link.
const fp = Function.prototype;
console.log(typeof fp, fp === Function.prototype, JSON.stringify(fp.name), fp.length);
console.log(fp(), fp(1, 2, 3));

function Base() {}
Object.setPrototypeOf(Base.prototype, Function.prototype);
console.log(Object.getPrototypeOf(Base.prototype) === Function.prototype);

const callable = (...args) => args.length;
Object.setPrototypeOf(callable, Base.prototype);
console.log(callable(1, 2), Object.getPrototypeOf(callable) === Base.prototype);
console.log(callable.apply(null, [1, 2, 3]), callable.call(null, 1));

const plain = Object.setPrototypeOf({ own: 1 }, Function.prototype);
console.log(typeof plain, plain.own, Object.getPrototypeOf(plain) === Function.prototype);
