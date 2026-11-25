// @requires-libnode
// The program's first use of a deferred island package starts Node. Here
// that use is in an asynchronous function the loop resumed (a promise job),
// which then awaits a file read that fails, inside try/catch: a start-up
// that reads its settings under a lock and then loads an optional file.
// The loop is handed to Node in the middle of the promise jobs, and the
// catch is one of them: Node reports nothing and prints the result.
import { readFile } from "node:fs/promises";
import { kit } from "turn-kit";

class Store {
  static create(): Store {
    const store = new Store();
    store.reload();
    return store;
  }
  count = -1;
  reload(): void {
    this.count = kit.count(); // the first island use: Node starts here
  }
}

async function load(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "(none)";
    throw error;
  }
}

async function create(): Promise<string> {
  await Promise.resolve();
  const store = Store.create();
  const text = await load("/scriptc/does/not/exist.json");
  return `${store.count} ${text}`;
}

async function services(): Promise<string> {
  await Promise.resolve();
  return await create();
}

console.log("result", await services());
