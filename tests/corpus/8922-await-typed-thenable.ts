// `await` of a value whose static type has a callable `then` calls it, as
// Node does, whether or not the awaited value is used: an object literal, a
// binding, a class instance, a union with a thenable arm, and a thenable that
// resolves with another. A `then` that throws or rejects rejects the await.
// A type whose `then` cannot be called, and a type with none, keep the
// one-turn await that answers the value.
const log: string[] = [];

class Lazy {
  private readonly label: string;
  constructor(label: string) {
    this.label = label;
  }
  then(resolve: (value: string) => void): void {
    console.log("then of", this.label);
    resolve(this.label.toUpperCase());
  }
}

class Counted {
  then(resolve: (value: number) => void): void {
    console.log("counted then");
    resolve(5);
  }
}

async function settle(v: Counted | number): Promise<void> {
  const x = await v;
  console.log("settled", x + 1);
}

async function main(): Promise<void> {
  // The awaited value is not used.
  log.push("a2");
  await {
    then(r: (v: number) => void) {
      log.push("thenable");
      r(1);
    },
  };
  log.push("a3");
  console.log(log.join(","));

  const t = {
    then(r: (v: number) => void): void {
      console.log("then called");
      r(42);
    },
  };
  await t;
  console.log("after await");

  // The awaited value is used, with the type the checker gives it.
  const x = await t;
  console.log("value", x + 1);

  await new Lazy("first");
  const upper = await new Lazy("second");
  console.log("got", upper.length, upper);

  await settle(3);
  await settle(new Counted());

  const inner = {
    then(r: (v: string) => void): void {
      console.log("inner then");
      r("done");
    },
  };
  const outer = {
    then(r: (v: typeof inner) => void): void {
      console.log("outer then");
      r(inner);
    },
  };
  console.log("nested", await outer);

  const bad = {
    then(_r: (v: number) => void): void {
      throw new RangeError("then threw");
    },
  };
  try {
    await bad;
    console.log("unreachable");
  } catch (e) {
    console.log("caught", (e as Error).name, (e as Error).message);
  }

  const rejects = {
    then(_r: (v: number) => void, reject: (e: unknown) => void): void {
      reject(new TypeError("rejected"));
    },
  };
  try {
    const never = await rejects;
    console.log("unreachable", never);
  } catch (e) {
    console.log("caught", (e as Error).name, (e as Error).message);
  }

  // Not thenables: a `then` that is no function, and no `then` at all.
  const plain = { then: 5, label: "plain" };
  const same = await plain;
  console.log(same.then, same.label, same === plain);
  const record = { label: "record" };
  console.log((await record).label);
}

// The order of turns, against a promise chain started in the same turn.
const order: string[] = [];
const turn = {
  then(r: (v: number) => void): void {
    order.push("then");
    r(1);
  },
};
async function ordered(): Promise<void> {
  order.push("a1");
  await turn;
  order.push("a2");
}

main()
  .then(() => {
    const done = ordered();
    Promise.resolve()
      .then(() => order.push("p1"))
      .then(() => order.push("p2"))
      .then(() => order.push("p3"));
    order.push("sync");
    return done.then(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  })
  .then(() => console.log(order.join(",")));
