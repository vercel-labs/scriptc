export {};
// A class method whose result is a union holding an AsyncGenerator must still
// hold its slot on the observed prototype. An untyped write onto an instance
// makes reads use that prototype, and the method's value has a
// checked-dynamic form: the promise settles with a record whose generator
// field boxes by identity. Before the generator joined the composite
// conversion domain the method had no dyn form, so the prototype install
// skipped it and calls answered undefined.
type Result =
  | { status: "inactive" | "steered" }
  | { status: "replaced"; iterator: AsyncGenerator<number> };

class Manager {
  before(): number {
    return 1;
  }
  async steer(flag: boolean): Promise<Result> {
    if (flag) return { status: "inactive" };
    async function* gen(): AsyncGenerator<number> {
      yield 1;
      yield 2;
    }
    return { status: "replaced", iterator: gen() };
  }
  after(): number {
    return 2;
  }
}

function tag(target: any, name: string, value: unknown): void {
  target[name] = value;
}

const manager = new Manager();
tag(manager, "extra", 1);
const run = async (): Promise<void> => {
  console.log("before", manager.before());
  const first = await manager.steer(true);
  console.log("steer", first.status);
  const second = await manager.steer(false);
  if (second.status === "replaced") {
    let total = 0;
    for await (const value of second.iterator) total += value;
    console.log("iterator", total);
  }
  console.log("after", manager.after());
};
void run();
