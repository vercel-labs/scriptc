// A builtin constructor reached only through the `constructor` member of an
// untyped value answers the static members the program calls with their
// function values.
const plain = JSON.parse('{"x":1,"y":2}');
const objectCtor = plain.constructor;
console.log(objectCtor.keys(plain), objectCtor.entries(plain).length, typeof objectCtor.groupBy);
const list = JSON.parse("[1,[2]]");
console.log(list.constructor.isArray(list), list.constructor.from("ab"));
