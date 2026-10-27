// util.promisify over untyped (`any`) functions: the callback's error
// rejects, its first value fulfills, a synchronous throw rejects, only the
// first settlement counts (also while a promise it fulfills with is still
// pending), and the call's receiver reaches the function.
import { promisify } from "node:util";

const client: any = {
  name: "db",
  close(callback: any) {
    setImmediate(() => callback());
  },
  fetch(key: any, callback: any) {
    setImmediate(() => (key ? callback(null, `${this.name}:${key}`, "ignored") : callback(new Error("no key"))));
  },
  twice(callback: any) {
    callback(null, "first");
    callback(new Error("second"));
  },
  boom(_callback: any) {
    throw new TypeError("synchronous failure");
  },
  adoptThenCall(callback: any) {
    callback(null, new Promise((resolve) => setTimeout(() => resolve("adopted"), 5)));
    callback(null, "second");
  },
  adoptThenReject(callback: any) {
    callback(null, new Promise((resolve) => setTimeout(() => resolve("adopted"), 5)));
    callback(new Error("late error"));
  },
  adoptThenThrow(callback: any) {
    callback(null, new Promise((resolve) => setTimeout(() => resolve("adopted"), 5)));
    throw new Error("late throw");
  },
};

async function main(): Promise<void> {
  await promisify(client.close.bind(client))();
  console.log("closed");
  const fetchAsync = promisify(client.fetch.bind(client));
  console.log(await fetchAsync("a"));
  try {
    await fetchAsync("");
  } catch (error) {
    console.log("rejected:", (error as Error).message);
  }
  console.log("twice:", await promisify(client.twice)());
  try {
    await promisify(client.boom)();
  } catch (error) {
    console.log("sync:", (error as Error).name, (error as Error).message);
  }
  for (const name of ["adoptThenCall", "adoptThenReject", "adoptThenThrow"]) {
    try {
      console.log(`${name}:`, await promisify(client[name])());
    } catch (error) {
      console.log(`${name} rejected:`, (error as Error).message);
    }
  }
  const unbound = promisify(client.fetch);
  console.log("receiver:", await unbound.call(client, "b"));
  const order: string[] = [];
  const pending = promisify(client.close.bind(client))().then(() => order.push("settled"));
  order.push("returned");
  await pending;
  console.log(order.join(", "));
}
void main();
