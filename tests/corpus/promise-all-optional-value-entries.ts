// Promise.all over optional entries whose promises fulfill a value: the
// `?.` shape `Promise<T | undefined> | undefined`. Node fulfills undefined
// for an entry that is undefined, and the entry's own value otherwise.
class Conn {
  closed = false;
  name: string;
  constructor(name: string) {
    this.name = name;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

class Server {
  client: Conn | undefined;
  opening: Promise<Conn> | undefined;
  // Awaited as a statement: two optional entries of different types.
  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    await Promise.all([client?.close().catch(() => undefined), this.opening?.catch(() => undefined)]);
    console.log("closed", client?.closed);
  }
  // The values are read: each position holds the entry's value or undefined.
  async settle(): Promise<string> {
    const settled = await Promise.all([
      this.client?.close().catch(() => undefined),
      this.opening?.catch(() => undefined),
    ]);
    const opened = settled[1];
    return `${settled.length}/${opened === undefined ? "none" : opened.name}`;
  }
}

function later<T>(value: T, ms: number): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

async function main(): Promise<void> {
  const none = new Server();
  await none.close();
  console.log(await none.settle());

  const both = new Server();
  both.client = new Conn("c");
  both.opening = Promise.resolve(new Conn("o"));
  console.log(await both.settle());
  await both.close();

  // A rejected optional promise that the entry's own catch answers.
  const failed = new Server();
  failed.opening = Promise.reject(new Error("no"));
  console.log(await failed.settle());
  await failed.close();

  // Beside a plain promise and a number: positions keep their order, whatever settles first.
  const slow: Promise<Conn | undefined> | undefined = later(new Conn("slow"), 20);
  const absent: Promise<string | undefined> | undefined = undefined as Promise<string | undefined> | undefined;
  const [a, b, c, d] = await Promise.all([slow, later("fast", 1), absent, 7]);
  console.log(a?.name, b, c, d);

  // A rejection in an optional entry rejects the whole call.
  const bad: Promise<Conn | undefined> | undefined = Promise.reject(new Error("entry failed"));
  try {
    await Promise.all([bad, later("unused", 1)]);
    console.log("no rejection");
  } catch (e) {
    console.log((e as Error).message);
  }

  // Settlement order against other microtasks.
  const order: string[] = [];
  const present: Promise<number | undefined> | undefined = Promise.resolve(1);
  const missing: Promise<number | undefined> | undefined = undefined as Promise<number | undefined> | undefined;
  const joined = Promise.all([present, missing, Promise.resolve("x")]).then((r) => order.push(`all:${r.join(",")}`));
  Promise.resolve()
    .then(() => order.push("t1"))
    .then(() => order.push("t2"))
    .then(() => order.push("t3"))
    .then(() => order.push("t4"));
  await joined;
  await later(0, 2);
  console.log(order.join(" "));
}
main();
