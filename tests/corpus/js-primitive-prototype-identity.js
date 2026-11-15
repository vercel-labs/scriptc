// One prototype object per kind: the value `Number.prototype` /
// `Boolean.prototype` reads is the compiled constructor's `prototype` member
// and the prototype of every wrapper of that kind.
console.log(Object(true).constructor.prototype === Boolean.prototype);
console.log(Object(1).constructor.prototype === Number.prototype);
console.log(Object.getPrototypeOf(new Boolean(true)) === Boolean.prototype);
console.log(Object.getPrototypeOf(new Number(2)) === Number.prototype);
console.log(new Boolean(true).constructor.prototype === Boolean.prototype);
console.log(new Number(2).constructor.prototype === Number.prototype);
console.log(Object.prototype.toString.call(Number.prototype));
console.log(Object.prototype.toString.call(Boolean.prototype));
console.log(Number.prototype.valueOf(), Boolean.prototype.valueOf(), Boolean.prototype.toString());
console.log(Number.prototype.toString(), Number.prototype.toString(2));
console.log(Number.prototype.toString.call(new Number(255), 16));
console.log(Number.prototype.toFixed.call(new Number(1.5), 2));
console.log(new Boolean(true).valueOf(), new Number(5).toString(2));
console.log(Number.prototype === Number.prototype, Boolean.prototype === Boolean.prototype);
const readFirst = Number.prototype;
console.log(Object(3).constructor.prototype === readFirst);
console.log(readFirst.constructor.prototype === readFirst);
