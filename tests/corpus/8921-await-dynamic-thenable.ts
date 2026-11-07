// `await` of a value typed `unknown` or `any` asks the value whether it is a
// thenable when the await runs, as JavaScript's PromiseResolve does. How the
// `then` got there does not matter: a key built at run time, a proxy trap, a
// class method behind `unknown`. A `then` that is not callable, and a value
// that has none, take the one-turn await and answer themselves.
const key = ["th", "en"].join("");

function computedKey(n: number): unknown {
  const box: Record<string, unknown> = {};
  box[key] = (resolve: (v: number) => void): void => {
    console.log("computed then", n);
    resolve(n);
  };
  return box;
}

function proxied(n: number): unknown {
  const handler: any = JSON.parse("{}");
  handler.get = (_target: unknown, name: unknown): unknown => {
    if (name !== key) return undefined;
    return (resolve: (v: number) => void): void => {
      console.log("proxy then", n);
      resolve(n);
    };
  };
  return new Proxy(JSON.parse("{}"), handler);
}

class Lazy {
  private readonly label: string;
  constructor(label: string) {
    this.label = label;
  }
  then(resolve: (v: string) => void): void {
    console.log("class then", this.label);
    resolve(this.label.toUpperCase());
  }
}

async function settle(label: string, value: unknown): Promise<void> {
  try {
    const settled = await value;
    console.log(label, "->", typeof settled, typeof settled === "object" ? JSON.stringify(settled) : String(settled));
  } catch (e) {
    console.log(label, "threw", (e as Error).name, (e as Error).message);
  }
}

async function main(): Promise<void> {
  await settle("computed key", computedKey(1));
  await settle("proxy", proxied(2));
  await settle("class", new Lazy("lazy"));
  await settle("number then", { then: 5 });
  await settle("no then", { other: 1 });
  await settle("string", "text");
  await settle("null", null);
  await settle("promise", Promise.resolve("p"));

  const throws: Record<string, unknown> = {};
  throws[key] = (): void => {
    throw new RangeError("then threw");
  };
  await settle("throwing then", throws);

  const rejects: Record<string, unknown> = {};
  rejects[key] = (_resolve: unknown, reject: (e: unknown) => void): void => {
    reject(new TypeError("then rejected"));
  };
  await settle("rejecting then", rejects);

  // Only the first settlement counts.
  const twice: Record<string, unknown> = {};
  twice[key] = (resolve: (v: string) => void, reject: (e: unknown) => void): void => {
    resolve("first");
    resolve("second");
    reject(new Error("late"));
  };
  await settle("settles twice", twice);

  // A thenable that resolves with a thenable: both are called.
  const outer: Record<string, unknown> = {};
  outer[key] = (resolve: (v: unknown) => void): void => {
    console.log("outer then");
    resolve(computedKey(3));
  };
  await settle("nested", outer);
}

// The order of turns: the thenable's `then` runs one turn after the await
// starts, and the await continues one turn after it resolves.
const order: string[] = [];
async function ordered(): Promise<void> {
  const box: Record<string, unknown> = {};
  box[key] = (resolve: (v: number) => void): void => {
    order.push("then");
    resolve(1);
  };
  order.push("a1");
  await (box as unknown);
  order.push("a2");
}

main().then(() => {
  const done = ordered();
  Promise.resolve()
    .then(() => order.push("p1"))
    .then(() => order.push("p2"))
    .then(() => order.push("p3"));
  order.push("sync");
  return done.then(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}).then(() => console.log(order.join(",")));
