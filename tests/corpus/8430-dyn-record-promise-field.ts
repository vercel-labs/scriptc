// A record whose field is a Promise converts into a checked-dynamic slot and
// back. The promise boxes by reference (SCR_DYN_PROMISE), so a round trip
// keeps the awaited payload and the promise's identity, exactly as in Node.
// A method answering the read state of a model store is the shape that raised
// SC1101: `reload?: { readers: number; promise: Promise<StoredModels> }`.

interface Reload {
  readers: number;
  promise: Promise<string>;
}
interface ReadState {
  data: number;
  revision?: string;
  reload?: Reload;
}
interface Waiter {
  label: string;
  done: Promise<void>;
}

function summary(u: unknown): string {
  const s = u as { data: number; revision?: string; reload?: { readers: number } };
  return `${s.data}/${s.revision ?? "-"}/${s.reload ? s.reload.readers : "-"}`;
}

function reopen(u: unknown): ReadState {
  return u as ReadState;
}

function labels(us: unknown[]): string {
  return us
    .map((u) => (u as Waiter).label)
    .join(",");
}

async function main(): Promise<void> {
  const payload = Promise.resolve("ready");
  const state: ReadState = {
    data: 7,
    revision: "r1",
    reload: { readers: 3, promise: payload },
  };
  console.log(summary(state));

  // The checked conversion back keeps the promise itself.
  const back: ReadState = reopen(state);
  console.log(`same promise: ${back.reload?.promise === payload}`);
  console.log(`payload: ${await back.reload?.promise}`);

  // Reading the promise off the dynamic view awaits the same payload.
  const live = (state as unknown) as { reload: { promise: unknown } };
  console.log(`live payload: ${await live.reload.promise}`);

  // An absent field stays absent, and a present-but-void promise settles.
  const bare: ReadState = { data: 1 };
  console.log(summary(bare), `no reload: ${bare.reload === undefined}`);

  let settled = false;
  const waiters: Waiter[] = [
    { label: "a", done: Promise.resolve() },
    { label: "b", done: Promise.resolve() },
  ];
  waiters[0]!.done.then(() => {
    settled = true;
  });
  console.log(`waiters: ${labels(waiters)}`);
  await waiters[0]!.done;
  console.log(`settled: ${settled}`);
}

main();
