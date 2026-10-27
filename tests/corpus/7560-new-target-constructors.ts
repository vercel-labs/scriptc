// new.target in class constructors: the class under construction, through
// inherited and explicit subclass constructors, Error subclasses, arrows,
// identity comparisons and class values.
abstract class AppError extends Error {
  abstract readonly status: number;
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
class NotFound extends AppError {
  readonly status = 404;
}
class Invalid extends AppError {
  readonly status = 400;
  readonly field: string;
  constructor(field: string, detail: number) {
    super(`bad ${field} ${detail}`);
    this.field = field;
  }
}
class Strict extends Invalid {}
const errors: AppError[] = [new NotFound("missing"), new Invalid("isbn", 3), new Strict("title", 1)];
for (const e of errors) console.log(e.name, e.status, e.message, String(e), e instanceof Invalid);

class Shape {
  readonly kind: string;
  readonly exact: boolean;
  constructor() {
    this.kind = new.target.name;
    this.exact = new.target === Shape;
    const probe = () => new.target !== Circle;
    console.log("probe", probe(), new.target == Square, new.target === undefined);
  }
  describe(): string {
    return `${this.kind}${this.exact ? " (exact)" : ""}`;
  }
}
class Circle extends Shape {}
class Square extends Shape {
  constructor() {
    super();
    console.log("square ctor sees", new.target.name);
  }
}
for (const s of [new Shape(), new Circle(), new Square()]) console.log(s.describe());

class Node2 {
  static make(): Node2 { return new this(); }
  readonly origin: typeof Node2;
  constructor() { this.origin = new.target; }
  where(): string | undefined { return typeof (() => 1)() === "number" ? String(this.origin.name) : undefined; }
}
class Leaf extends Node2 {}
console.log(new Node2().origin === Node2, new Leaf().origin === Leaf, new Leaf().where(), Node2.make().origin.name);
