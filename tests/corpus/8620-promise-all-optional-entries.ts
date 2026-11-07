// Promise.all over entries that may be ABSENT: an optional-chained async
// call, an optional property or `?.catch(...)` types as
// `Promise<T> | undefined`. Node resolves a non-thenable entry as itself,
// so an absent entry contributes undefined while the present ones settle
// normally, and the settlement order is unchanged —
// the tuple form (`Promise.all([a.close(), a.ready])`), the array form
// (`Promise.all(xs.map((x) => x.ready))`), plain values beside an optional
// entry, optional entries whose payload is a union with undefined,
// rejection, and microtask turns. A void tuple/array result is discarded
// (its slots are void, which no binding holds), so the value assertions
// ride the payload-union forms.
type Shop = { name: string; close(): Promise<void>; ready?: Promise<void> };

class Session {
  label: string;
  constructor(label: string) {
    this.label = label;
  }
  async close(): Promise<void> {
    await Promise.resolve();
    console.log("session closed", this.label);
  }
  async shutdown(): Promise<Session | undefined> {
    await Promise.resolve();
    return this;
  }
}

function shop(name: string, open: boolean): Shop {
  const s: Shop = {
    name,
    async close(): Promise<void> {
      await Promise.resolve();
      console.log("closed", name);
    },
  };
  if (open) s.ready = Promise.resolve(undefined).then(() => console.log("ready", name));
  return s;
}

function maybeSession(label: string, present: boolean): Session | undefined {
  if (!present) return undefined;
  return new Session(label);
}

function openingOf(label: string, open: boolean): Promise<Session> | undefined {
  if (!open) return undefined;
  return Promise.resolve(new Session(label));
}

function lookupOf(label: string, present: boolean): Promise<Session | undefined> | undefined {
  if (!present) return undefined;
  return Promise.resolve(maybeSession(label, present));
}

async function failing(): Promise<void> {
  await Promise.resolve();
  throw new Error("close refused");
}

async function failLater(): Promise<number> {
  await Promise.resolve();
  console.log("late failure");
  throw new Error("late");
}

async function tupleForms(): Promise<void> {
  const open = shop("open", true);
  await Promise.all([open.close(), open.ready]);
  console.log("tuple present done");

  // The optional-property form: a promise held only while the shop is open.
  const shut = shop("shut", false);
  let closing: Promise<void> | undefined;
  closing = Promise.all([shut.close(), shut.ready]).then(() => undefined);
  const pending = closing;
  try {
    await pending;
  } finally {
    if (closing === pending) closing = undefined;
  }
  console.log("tuple absent done", closing === undefined);
}

async function arrayForms(): Promise<void> {
  const shops = [shop("a", true), shop("b", false), shop("c", true)];
  await Promise.all(shops.map((s) => s.ready));
  console.log("mapped done");
  await Promise.all(shops.map((s) => s.ready && s.close()));
  console.log("mapped closes done");
  const empty: Shop[] = [];
  await Promise.all(empty.map((s) => s.ready));
  console.log("empty done", empty.length);
}

async function plainBesideOptional(): Promise<void> {
  const gone = maybeSession("gone", false);
  const [count, lost, label] = await Promise.all([1, gone?.shutdown(), "text"]);
  console.log("plain", count + 1, lost === undefined, label);
}

async function payloadUnion(): Promise<void> {
  const live = maybeSession("live", true);
  const gone = maybeSession("gone", false);
  const [kept, lost] = await Promise.all([live?.shutdown(), gone?.shutdown()]);
  console.log("payload", kept?.label, lost === undefined);

  // `?.catch(...)` keeps undefined in the payload: Promise<Session | undefined>.
  // (The first slot's type is `void | undefined`, which no binding holds, so
  // the pattern skips it.)
  const ready = openingOf("opened", true);
  const [, nothing] = await Promise.all([
    live?.close().catch(() => undefined),
    ready?.catch(() => undefined),
  ]);
  console.log("payload catch", nothing?.label);

  // An optional entry whose payload already holds undefined (the
  // `Promise<T | undefined> | undefined` form) settles with the payload
  // when it is there and with undefined when it is not.
  const [here, absent] = await Promise.all([
    lookupOf("first", true),
    lookupOf("second", false),
  ]);
  console.log("payload optional", here?.label, absent === undefined);
}

async function rejections(): Promise<void> {
  const shut = shop("rejects", false);
  try {
    await Promise.all([shut.ready, failing()]);
    console.log("unreachable");
  } catch (err) {
    console.log("rejected", (err as Error).message);
  }

  const absent = Promise.all([shut.ready, shut.ready]);
  absent.then(() => console.log("absent settled"));
  await absent;
  console.log("absent awaited");

  try {
    await Promise.all([shut.ready, failLater()]);
    console.log("unreachable late");
  } catch (err) {
    console.log("late rejected", (err as Error).message);
  }
}

async function turns(): Promise<void> {
  const shut = shop("turns", false);
  const all = Promise.all([shut.close(), shut.ready]);
  all.then(() => console.log("all fulfilled"));
  Promise.resolve()
    .then(() => console.log("tick 1"))
    .then(() => console.log("tick 2"))
    .then(() => console.log("tick 3"))
    .then(() => console.log("tick 4"));
  await all;
  console.log("awaited the all");
}

async function main(): Promise<void> {
  await tupleForms();
  await arrayForms();
  await plainBesideOptional();
  await payloadUnion();
  await rejections();
  await turns();
  console.log("done");
}

void main();
