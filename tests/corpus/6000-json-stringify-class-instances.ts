class Point {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
  norm(): number {
    return Math.hypot(this.x, this.y);
  }
}

class Account {
  static count = 0;
  #secret = "hidden";
  private balance = 10;
  protected owner = "ada";
  label: string | undefined = undefined;
  tags: string[] = ["a", "b"];
  get secret(): string {
    return this.#secret;
  }
}

class Stamp {
  at = 5;
  toJSON(key: string): string {
    return `stamp(${key})`;
  }
}

class Base {
  kind = "base";
  toJSON(): { kind: string; via: string } {
    return { kind: this.kind, via: "Base.toJSON" };
  }
}
class Child extends Base {
  extra = 1;
}

class Labeled extends Point {
  name = "p";
}

class Box<T> {
  value: T;
  constructor(value: T) {
    this.value = value;
  }
}

class Registry {
  entries = new Map<string, number>([["a", 1]]);
  count = 2;
}

class Cycle {
  name = "loop";
  next: Cycle | null = null;
}

class Big {
  n = 10n;
}

const tag = Symbol("tag");

class Handlers {
  name = "h";
  onEvent = (n: number): number => n + 1;
  payload: unknown = { a: [1, "two", null] };
  [tag] = "symbol-keyed";
}

class Failure extends Error {
  code = "E_FAIL";
}

class Empty {}

class Tagged {
  s = new Set<number>([1, 2]);
  count = 2;
}

const p = new Point(3, 4);
console.log(JSON.stringify(p));
console.log(JSON.stringify(new Account()));
console.log(JSON.stringify(new Stamp()));
console.log(JSON.stringify({ first: new Stamp(), list: [new Stamp()] }));
console.log(JSON.stringify(new Child()));
console.log(JSON.stringify(new Labeled(1, 2)));
console.log(JSON.stringify(new Box("text")), JSON.stringify(new Box(new Point(0, 1))));
console.log(JSON.stringify(new Registry()));
console.log(JSON.stringify([p, null, new Point(5, 6)]));
console.log(JSON.stringify({ point: p, points: [p, p] }, null, 2));
console.log(JSON.stringify(p, null, "--"));
console.log(JSON.stringify(p, ["x"]));
console.log(JSON.stringify(p, (key: string, value: unknown) => (key === "y" ? undefined : value)));

const maybe: Point | null = Math.random() < 2 ? p : null;
console.log(JSON.stringify(maybe));

const loop = new Cycle();
loop.next = loop;
try {
  JSON.stringify(loop);
  console.log("no error");
} catch (e) {
  console.log(e instanceof TypeError);
}

try {
  JSON.stringify(new Big());
  console.log("no error");
} catch (e) {
  console.log(e instanceof TypeError);
}

p.x = 30;
console.log(JSON.stringify(p));

const h = new Handlers();
console.log(JSON.stringify(h));
console.log(JSON.stringify(new Empty()));
console.log(JSON.stringify(new Failure("boom")));
h.payload = 7;
console.log(JSON.stringify({ handlers: [h] }));
const u: unknown = new Map([["a", 1]]);
console.log(JSON.stringify(new Tagged()), JSON.stringify(u));

// Date fields write their toJSON text, also in nested instances.
class Schedule {
  name = "weekly";
  next = new Date(Date.UTC(2024, 0, 1));
}
class Calendar {
  title = "team";
  schedules: Schedule[] = [new Schedule()];
}
console.log(JSON.stringify(new Schedule()));
console.log(JSON.stringify({ calendar: new Calendar() }));
