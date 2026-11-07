// `Symbol.prototype.description` answers undefined for a symbol created
// without a description: the getter's brand check accepts the symbol, and
// the absent description is the value it answers.
const getter = Object.getOwnPropertyDescriptor(Symbol.prototype, "description").get;
const plain = Symbol("plain");
const bare = Symbol();
console.log(Reflect.apply(getter, plain, []));
console.log(Reflect.apply(getter, bare, []));
console.log(plain.description);
console.log(bare.description);
