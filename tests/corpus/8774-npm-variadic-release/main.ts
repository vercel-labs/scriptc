// A package whose JavaScript wraps callback functions as `(...given) => …`
// and whose separate declaration package types the results `() => void`
// and `() => Promise<void>`: the release functions are returned through
// those annotations, kept in a field and in an optional slot, and called.
import holder from "hold-file";

class Store {
  private kept: (() => void) | undefined;
  private take(name: string): () => void {
    for (let attempt = 1; ; attempt++) {
      try {
        return holder.holdSync(name, {});
      } catch (error) {
        if (attempt === 2) throw error;
      }
    }
  }
  run(name: string): void {
    let release: (() => void) | undefined;
    try {
      release = this.take(name);
      console.log("held", holder.checkSync(name));
    } finally {
      if (release) release();
    }
    console.log("after", holder.checkSync(name));
  }
  keep(name: string): void {
    this.kept = this.take(name);
  }
  drop(): void {
    if (this.kept) this.kept();
    this.kept = undefined;
  }
}

async function taken(name: string): Promise<() => Promise<void>> {
  let release: (() => Promise<void>) | undefined;
  release = await holder.hold(name, {});
  return release;
}

async function direct(name: string, failRelease: boolean): Promise<void> {
  let release: () => Promise<void>;
  try {
    release = await holder.hold(name, { failRelease });
  } catch (error) {
    console.log("refused", (error as Error).message);
    return;
  }
  console.log("held", holder.checkSync(name));
  try {
    const settled = release();
    console.log("promise", settled instanceof Promise);
    await settled;
    console.log("released", holder.checkSync(name));
  } catch (error) {
    console.log("release threw", (error as Error).message, holder.checkSync(name));
  }
}

async function main(): Promise<void> {
  const store = new Store();
  store.run("a");
  store.keep("b");
  console.log("kept", holder.checkSync("b"));
  try {
    store.run("b");
  } catch (error) {
    console.log("caught", (error as Error).message);
  }
  store.drop();
  console.log("dropped", holder.checkSync("b"));
  for (let i = 0; i < 100; i++) {
    store.keep("k" + i);
    store.drop();
  }
  const release = await taken("c");
  console.log("taken", holder.checkSync("c"));
  await release();
  console.log("given back", holder.checkSync("c"));
  await direct("d", false);
  await direct("e", true);
  const first = await taken("f");
  await direct("f", false);
  await first();
  for (let i = 0; i < 100; i++) await (await taken("m" + i))();
  console.log("end", holder.checkSync("f"));
}
main();
