// @requires-libnode
// A store behind an interface with a file implementation that takes a lock
// from an island package: the generic method computes its result under the
// lock, releases the lock in `finally` (the release promise settles from a
// file system callback with undefined) and returns the result.
import lockfile from "lock-pkg";

type LockResult<T> = { result: T; next?: string };

interface Backend {
  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
  withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T>;
}

class FileBackend implements Backend {
  private content: string | undefined = '{"models":["a","b"],"revision":3}';
  private readonly file: string;
  constructor(file: string) {
    this.file = file;
  }

  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
    let release: (() => void) | undefined;
    try {
      release = lockfile.lockSync(this.file, { realpath: false });
      const { result, next } = fn(this.content);
      if (next !== undefined) this.content = next;
      return result;
    } finally {
      if (release) release();
    }
  }

  // Takes the lock, retrying while another holder has it; the release it
  // answers is a native async function around the package's.
  private async acquireLockAsync(onCompromised: (error: Error) => void): Promise<() => Promise<void>> {
    let attempts = 0;
    while (true) {
      let release: (() => Promise<void>) | undefined;
      try {
        const packageRelease = await lockfile.lock(this.file, {
          realpath: false,
          retries: 0,
          stale: 30000,
          onCompromised,
        });
        release = async () => {
          await packageRelease();
        };
      } catch (error) {
        attempts++;
        if (attempts > 3) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        continue;
      }
      return release;
    }
  }

  async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
    let release: (() => Promise<void>) | undefined;
    let lockCompromised = false;
    let lockCompromisedError: Error | undefined;
    const throwIfCompromised = (): void => {
      if (lockCompromised) throw lockCompromisedError ?? new Error("lock was compromised");
    };
    try {
      release = await this.acquireLockAsync((err) => {
        lockCompromised = true;
        lockCompromisedError = err;
      });
      throwIfCompromised();
      const { result, next } = await fn(this.content);
      throwIfCompromised();
      if (next !== undefined) this.content = next;
      throwIfCompromised();
      return result;
    } finally {
      if (release) {
        try {
          await release();
        } catch {
          // The lock may have been compromised and removed already.
        }
      }
    }
  }
}

class MemoryBackend implements Backend {
  private value: string | undefined;
  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
    const { result, next } = fn(this.value);
    if (next !== undefined) this.value = next;
    return result;
  }
  async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
    const { result, next } = await fn(this.value);
    if (next !== undefined) this.value = next;
    return result;
  }
}

type Stored = { models?: string[]; revision?: number };

class Store {
  private models: string[] = [];
  private readonly storage: Backend;
  constructor(storage: Backend) {
    this.storage = storage;
  }
  private parse(content: string | undefined): Stored {
    return content ? (JSON.parse(content) as Stored) : {};
  }
  private reloadFromStorage(): Promise<Stored> {
    return this.storage.withLockAsync(async (content) => {
      const data = this.parse(content);
      this.models = data.models ?? [];
      return { result: data };
    });
  }
  // The reload in flight is kept in a record, observed with `then` and
  // awaited by every reader.
  private pending: { promise: Promise<Stored>; readers: number } | undefined;
  async reload(): Promise<void> {
    if (!this.pending) {
      const pending = { promise: this.reloadFromStorage(), readers: 0 };
      this.pending = pending;
      void pending.promise.then(
        () => {
          if (this.pending === pending) this.pending = undefined;
        },
        () => {
          if (this.pending === pending) this.pending = undefined;
        },
      );
    }
    const pending = this.pending;
    pending.readers++;
    const data = await pending.promise;
    console.log("reloaded", data.revision ?? "no revision", pending.readers);
  }
  names(): Promise<string[]> {
    return this.storage.withLockAsync(async (content) => ({ result: this.parse(content).models ?? ["none"] }));
  }
  list(): string[] {
    return this.models;
  }
  async add(name: string): Promise<number> {
    return this.storage.withLockAsync(async (content) => {
      const data = this.parse(content);
      const models = [...(data.models ?? []), name];
      return { result: models.length, next: JSON.stringify({ ...data, models }) };
    });
  }
  count(): number {
    return this.storage.withLock((content) => ({ result: this.parse(content).models?.length ?? 0 }));
  }
}

async function main(): Promise<void> {
  const backends: Backend[] = [new FileBackend("models-store.json"), new MemoryBackend()];
  for (const backend of backends) {
    const store = new Store(backend);
    await store.reload();
    console.log(store.list().join(","), store.list().length, store.count());
    console.log((await store.names()).join(","));
    console.log(await store.add("c"));
    await store.reload();
    console.log(store.list().join(","), store.count());
  }
  const c = lockfile.counts();
  console.log(c.taken, c.released);
}

void main();
