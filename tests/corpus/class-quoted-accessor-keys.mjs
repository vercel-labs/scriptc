// Methods whose quoted names begin with "get:" or "set:", next to an
// accessor of the property after the prefix, read and called through
// untyped values.
class Quoted {
  "get:size"() {
    return "method get:size";
  }
  "set:size"(value) {
    return `method set:size ${value}`;
  }
  get size() {
    return 3;
  }
}
class Sized {
  constructor() {
    this.size = 5;
  }
}
const values = [new Quoted(), new Sized(), { "get:size": () => "record get:size", size: 1 }];
for (const value of values) {
  const getter = value["get:size"];
  console.log(typeof getter, getter?.call(value));
  console.log(typeof value["set:size"], value.size);
  if (value instanceof Quoted) console.log(value["get:size"](), value["set:size"](7));
}
