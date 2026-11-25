// Promise.all over an ARRAY LITERAL that mixes a plain Promise<void> with the
// armed `Promise<void> | undefined` an optional call yields — the
// `Promise.all([close(), opening?.catch(...)])` shape. Node fulfills a
// non-promise entry with undefined, so the undefined arm settles at once and
// the combinator still resolves in input order. 8801 covers the same mix in
// an ANNOTATED array expression and the [Promise<T>, undefined] tuple;
// this pins the literal whose entries are all optional calls.

let closed = 0;

interface Handle {
  close(): Promise<void>;
}

class Opening {
  handle: Handle | undefined;
  opening: Promise<void> | undefined;

  start(): void {
    this.handle = {
      close: async () => {
        closed += 1;
        console.log("closed", closed);
      },
    };
    this.opening = (async () => {
      await Promise.resolve();
      console.log("opened");
    })();
  }

  async stop(): Promise<void> {
    const handle = this.handle;
    this.handle = undefined;
    const opening = this.opening;
    this.opening = undefined;
    // Both entries may be undefined: the optional calls type as
    // Promise<void> | undefined, and `opening?.catch(...)` is the second arm.
    await Promise.all([handle?.close().catch(() => undefined), opening?.catch(() => undefined)]);
    console.log("stopped");
  }
}

const o = new Opening();
await o.stop();
o.start();
await o.stop();
await o.stop();

// One plain promise beside one armed union is the same mix the other way
// round, and a rejecting arm settles the whole set once its own catch runs.
let rejections = 0;

const failing = async (): Promise<void> => {
  throw new Error("boom");
};

async function settle(pending: Promise<void> | undefined): Promise<void> {
  await Promise.all([
    Promise.resolve().then(() => console.log("plain")),
    pending?.catch(() => {
      rejections += 1;
      console.log("caught");
    }),
  ]);
  console.log("resolved", rejections);
}

await settle(undefined);
await settle(failing());
console.log("done", closed);
