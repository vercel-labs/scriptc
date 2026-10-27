// util.promisify over typed callback-last functions with leading arguments
// under @types/node: bound methods, a function declaration, rejection from
// the callback error, a synchronous throw, and asynchronous settlement.
import { promisify } from "node:util";

class Client {
  private closed = false;
  private readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
  close(callback: (error?: Error) => void): void {
    setTimeout(() => {
      if (this.closed) {
        callback(new Error(`${this.name} already closed`));
        return;
      }
      this.closed = true;
      callback();
    }, 1);
  }
  fetch(key: string, callback: (error: Error | null, value?: string) => void): void {
    setImmediate(() => {
      if (key === "") callback(new RangeError("empty key"));
      else callback(null, `${this.name}:${key}`);
    });
  }
}

function sum(a: number, b: number, done: (err: Error | null, total: number) => void): void {
  if (a < 0) throw new TypeError("negative");
  process.nextTick(() => done(null, a + b));
}

async function main(): Promise<void> {
  const c = new Client("db");
  const closeAsync = promisify(c.close.bind(c));
  await closeAsync();
  console.log("closed once");
  try {
    await closeAsync();
  } catch (e) {
    console.log("second close:", (e as Error).message);
  }
  const fetchAsync = promisify(c.fetch.bind(c));
  console.log(await fetchAsync("k"));
  try {
    await fetchAsync("");
  } catch (e) {
    console.log("fetch:", (e as Error).name, (e as Error).message);
  }
  const sumAsync = promisify(sum);
  console.log("sum", await sumAsync(2, 3));
  try {
    await sumAsync(-1, 3);
  } catch (e) {
    console.log("sync throw:", (e as Error).name, (e as Error).message);
  }
  await promisify(new Client("inline").close.bind(new Client("inline")))();
  console.log("inline done");
  const order: string[] = [];
  const p = sumAsync(1, 1).then((v) => order.push(`then ${v}`));
  order.push("after call");
  await p;
  console.log(order.join(", "));
}
void main();
