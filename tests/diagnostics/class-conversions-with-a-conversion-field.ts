// A conversion through a base class whose methods a computed write may
// replace still judges every class below it: a subclass with a field named
// like a conversion method is refused, as it is without the write.
class Other {
  toString(): string {
    return "other";
  }
}
class Base {
  name = "b";
}
class Sub extends Base {
  toString: unknown = "not callable";
}
function put(target: any, key: string, value: unknown): void {
  target[key] = value;
}
put(new Base(), "x" + 1, 1);
const items: Base[] = [new Base(), new Sub()];
console.log(items.map((item) => String(item)).join(" | "), String(new Other()));
