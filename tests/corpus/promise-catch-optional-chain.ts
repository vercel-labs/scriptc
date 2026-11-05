// `?.` reaches a promise method through a receiver that may be nullish:
// `p?.catch(handler)` guards the method read (JS calls nothing when `p` is
// nullish), and the chain tail `f()?.then(..).catch(..)` guards the whole
// tail. The guarded call itself is an ordinary promise method call, so the
// handler typing sees the promise arm, and the chain result is
// `Promise<..> | undefined`.

interface Client {
  name: string;
}

class Box {
  opening: Promise<Client> | undefined;
  pending: Promise<void> | undefined;

  constructor(opening: Promise<Client> | undefined, pending: Promise<void> | undefined) {
    this.opening = opening;
    this.pending = pending;
  }

  async run(): Promise<void> {
    this.opening?.catch(() => undefined);
    console.log("1 opening guarded");
    await this.pending?.catch(() => undefined);
    console.log("2 pending guarded");
  }
}

function open(name: string): Promise<Client> {
  return Promise.resolve({ name });
}

function pick(flag: boolean): Promise<string> | undefined {
  return flag ? Promise.resolve("value") : undefined;
}

function tail(flag: boolean): Promise<number | undefined> {
  return pick(flag)!
    .then((value) => {
      console.log("tail then", value);
      return value.length;
    })
    .catch(() => undefined);
}

function guardedTail(flag: boolean): void {
  pick(flag)?.then((value) => {
    console.log("guarded then", value);
    return value.length;
  });
  console.log("3 tail attached", flag);
}

const present = new Box(open("digest"), Promise.resolve());
const absent = new Box(undefined, undefined);
present
  .run()
  .then(() => absent.run())
  .then(() => tail(true))
  .then(() => {
    guardedTail(true);
    guardedTail(false);
  })
  .then(() => console.log("done"));
