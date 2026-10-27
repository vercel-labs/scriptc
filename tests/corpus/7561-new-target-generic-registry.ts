// new.target in generic classes and as a construction registry key.
class Box<T> {
  readonly label: string;
  readonly value: T;
  constructor(value: T) {
    this.value = value;
    this.label = `${new.target.name}<${typeof value}>`;
  }
}
class NumBox extends Box<number> {
  constructor(n: number) {
    super(n * 2);
  }
}
const a = new Box("s");
const b = new NumBox(4);
console.log(a.label, b.label, b.value);

class Registry {
  static readonly created: string[] = [];
  constructor() {
    Registry.created.push(new.target.name);
    if (new.target === Registry) console.log("plain registry");
  }
}
class Users extends Registry {}
class Books extends Registry {}
new Users();
new Books();
new Registry();
new Books();
console.log(Registry.created.join(","));
