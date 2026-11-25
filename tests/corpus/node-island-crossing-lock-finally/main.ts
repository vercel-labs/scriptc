// @requires-libnode
// A generic async function that takes a lock from an island package,
// computes its result, and releases the lock in `finally`: the release
// promise settles from a file system callback with undefined, and the
// function still returns the result it computed before.
import { counts, lock } from "lock-pkg";

type LockResult<T> = { result: T; next?: string };

interface Backend {
  withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T>;
}

class FileBackend implements Backend {
  private content: string | undefined = '{"models":["a","b"],"revision":3}';
  private readonly file: string;
  constructor(file: string) {
    this.file = file;
  }

  async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lock(this.file, { retries: 1 });
      const { result, next } = await fn(this.content);
      if (next !== undefined) this.content = next;
      return result;
    } finally {
      if (release) {
        await release();
      }
    }
  }

  // The same without `finally`: the release is awaited before the return.
  async withLockPlain<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
    const release = await lock(this.file);
    const { result, next } = await fn(this.content);
    if (next !== undefined) this.content = next;
    await release();
    return result;
  }
}

type Stored = { models?: string[]; revision?: number };

class Store {
  private readonly storage: FileBackend;
  constructor(storage: FileBackend) {
    this.storage = storage;
  }
  private parse(content: string | undefined): Stored {
    return content ? (JSON.parse(content) as Stored) : {};
  }
  reload(): Promise<Stored> {
    return this.storage.withLockAsync(async (content) => ({ result: this.parse(content) }));
  }
  names(): Promise<string[]> {
    return this.storage.withLockAsync(async (content) => ({ result: this.parse(content).models ?? ["none"] }));
  }
  revision(): Promise<number> {
    return this.storage.withLockAsync(async (content) => ({ result: this.parse(content).revision ?? 0 }));
  }
  namesPlain(): Promise<string[]> {
    return this.storage.withLockPlain(async (content) => ({ result: this.parse(content).models ?? ["none"] }));
  }
  async failing(): Promise<string> {
    try {
      await this.storage.withLockAsync(async (): Promise<LockResult<string[]>> => {
        throw new Error("callback failed");
      });
      return "did not throw";
    } catch (e) {
      return (e as Error).message;
    }
  }
}

async function main(): Promise<void> {
  const store = new Store(new FileBackend("models-store.json"));
  const names = await store.names();
  console.log(names.join(","), names.length);
  console.log(JSON.stringify(await store.reload()));
  console.log(await store.revision());
  console.log((await store.namesPlain()).join(","));
  console.log(await store.failing());
  const c = counts();
  console.log(c.taken, c.released);
}

void main();
