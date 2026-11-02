// AsyncDisposableStack from JavaScript: disposeAsync disposes in reverse
// registration order, awaiting each disposal, with the microtask ticks
// DisposeResources costs observable. Node.js prints the same.
const log = (...args) => console.log(...args);

// An empty stack resolves before the call returns; a stack of null and
// undefined resources owes the closing Await(undefined), one tick later.
async function ticks() {
  const empty = [];
  new AsyncDisposableStack().disposeAsync().then(() => empty.push("disposed"));
  Promise.resolve().then(() => empty.push("job 1"));
  Promise.resolve().then(() => empty.push("job 2"));
  await null;
  await null;
  await null;
  log("empty:", empty.join(","));

  const nulls = [];
  const stack = new AsyncDisposableStack();
  stack.use(null);
  stack.use(undefined);
  stack.disposeAsync().then(() => nulls.push("disposed"));
  Promise.resolve().then(() => nulls.push("job 1"));
  Promise.resolve().then(() => nulls.push("job 2"));
  await null;
  await null;
  await null;
  await null;
  log("nullish:", nulls.join(","));

  const twice = [];
  const twiceStack = new AsyncDisposableStack();
  twiceStack.disposeAsync().then(() => twice.push("first"));
  twiceStack.disposeAsync().then(() => twice.push("second"));
  await null;
  await null;
  log("disposed twice:", twice.join(","), twiceStack.disposed);
}

async function order() {
  const seen = [];
  const resource = (name) => ({
    async [Symbol.asyncDispose]() {
      seen.push("enter " + name);
      await null;
      seen.push("exit " + name);
    },
  });
  const stack = new AsyncDisposableStack();
  log("use answers the resource:", stack.use(resource("a")) !== null);
  log("defer answers undefined:", stack.defer(async () => seen.push("defer")));
  log("adopt answers the value:", stack.adopt(7, async (value) => seen.push("adopt " + value)));
  stack.use(resource("b"));
  const answer = await stack.disposeAsync();
  log("disposeAsync answer:", answer, "disposed:", stack.disposed);
  log("order:", seen.join(" | "));
}

// The disposal method is read once, at registration, and the sync fallback
// still runs under the await.
async function registration() {
  const seen = [];
  const read = [];
  const resource = {
    get [Symbol.asyncDispose]() {
      read.push("asyncDispose read");
      return async () => seen.push("async disposed");
    },
    get [Symbol.dispose]() {
      read.push("dispose read");
      return () => seen.push("sync disposed");
    },
  };
  const stack = new AsyncDisposableStack();
  stack.use(resource);
  log("reads:", read.join(", "));
  await stack.disposeAsync();
  log("called:", seen.join(", "));

  const syncOnly = [];
  const syncStack = new AsyncDisposableStack();
  syncStack.use({
    [Symbol.dispose]() {
      syncOnly.push("sync fallback");
      return Promise.resolve().then(() => syncOnly.push("ignored answer"));
    },
  });
  await syncStack.disposeAsync();
  log("fallback:", syncOnly.join(", "));
}

function move() {
  const stack = new AsyncDisposableStack();
  stack.defer(async () => log("ran on the moved stack"));
  const moved = stack.move();
  log("move:", stack.disposed, moved.disposed, moved instanceof AsyncDisposableStack, moved !== stack);
  log("move answer:", moved.move().disposed);
}

async function failures() {
  const order = [];
  const stack = new AsyncDisposableStack();
  stack.defer(async () => {
    order.push("one");
    throw new Error("one");
  });
  stack.use({
    async [Symbol.asyncDispose]() {
      order.push("two");
      throw new TypeError("two");
    },
  });
  stack.defer(async () => {
    order.push("three");
  });
  try {
    await stack.disposeAsync();
  } catch (error) {
    log("suppressed:", error.name, error.message, error.error.name, error.error.message, error.suppressed.name, error.suppressed.message);
  }
  log("failures order:", order.join(","));

  const single = new AsyncDisposableStack();
  single.defer(async () => {
    throw "plain";
  });
  try {
    await single.disposeAsync();
  } catch (error) {
    log("single:", typeof error, error);
  }
}

// `await using` over the stack itself: scope exit calls its disposeAsync and
// awaits the promise (the stack is a constructible, disposable resource).
async function usingForm() {
  const seen = [];
  {
    await using stack = new AsyncDisposableStack();
    stack.use({
      async [Symbol.asyncDispose]() {
        seen.push("enter");
        await null;
        seen.push("exit");
      },
    });
    stack.defer(async () => seen.push("defer"));
    seen.push("inside " + String(stack.disposed));
  }
  seen.push("after");
  log("using:", seen.join(" | "));
}

async function main() {
  await ticks();
  await usingForm();
  await order();
  await registration();
  move();
  await failures();
}
main();
