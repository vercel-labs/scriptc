// A rejection that was reported as unhandled and gains a handler later is
// told to 'rejectionHandled' once, after the handler's own job has run,
// whichever of the promise and its untyped views was reported and whichever
// of them gains the handler.
export {};

type Parcel = { label: string; arrival: Promise<string> };

let reports = 0;
let late = 0;
process.on("unhandledRejection", (reason: unknown) => {
  reports += 1;
  console.log("  unhandled:", reason instanceof Error ? reason.message : String(reason));
});
process.on("rejectionHandled", (promise: unknown) => {
  late += 1;
  console.log("  handled late:", promise instanceof Promise);
});

function pause(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 2);
  });
}

function peek(record: unknown, key: string): unknown {
  return (record as Record<string, unknown>)[key];
}

function pass(value: unknown): unknown {
  return value;
}

function note(label: string): (why: unknown) => void {
  return (why: unknown) => {
    console.log("  " + label + ":", why instanceof Error ? why.message : String(why));
  };
}

async function waitFor(p: Promise<string>, label: string): Promise<void> {
  try {
    await p;
  } catch (why) {
    note(label)(why);
  }
}

async function waitAny(p: unknown, label: string): Promise<void> {
  try {
    await p;
  } catch (why) {
    note(label)(why);
  }
}

function track(thenable: unknown, label: string): void {
  const like = thenable as PromiseLike<unknown>;
  like.then(
    (value: unknown) => {
      console.log("  " + label + " value:", String(value));
    },
    note(label),
  );
}

function lost(name: string): Promise<string> {
  return Promise.reject(new Error(name));
}

async function main(): Promise<void> {
  const shelf: unknown[] = [];

  console.log("no view: catch, a timer later");
  const plain = lost("plain");
  await pause();
  plain.catch(note("caught"));
  console.log("  attached");
  await pause();

  console.log("no view: await in try, a timer later");
  const awaited = lost("awaited");
  await pause();
  void waitFor(awaited, "awaited in try");
  console.log("  attached");
  await pause();

  console.log("no view: allSettled, a timer later");
  const listed = lost("listed");
  await pause();
  void Promise.allSettled([listed]).then((rows) => {
    console.log("  settled:", rows[0].status);
  });
  console.log("  attached");
  await pause();

  console.log("an idle view is reported; the handler goes on the promise");
  const first = lost("first");
  const parcel: Parcel = { label: "p1", arrival: first };
  shelf.push(peek(parcel, "arrival"));
  await pause();
  first.catch(note("caught on the promise"));
  console.log("  attached");
  await pause();

  console.log("the promise is reported; a view made later is awaited");
  const second = lost("second");
  await pause();
  void waitAny(pass(second), "awaited through the view");
  console.log("  attached");
  await pause();

  console.log("two views; the first is handled, then the second, then the promise");
  const third = lost("third");
  const crate: Parcel = { label: "p3", arrival: third };
  const one = peek(crate, "arrival");
  const two = peek(crate, "arrival");
  await pause();
  (one as Promise<unknown>).catch(note("caught on the first view"));
  console.log("  attached");
  await pause();
  void waitAny(two, "awaited through the second view");
  await pause();
  third.then(undefined, note("then on the promise"));
  await pause();

  console.log("a view is tracked with two callbacks, a timer later");
  const fourth = lost("fourth");
  const box: Parcel = { label: "p4", arrival: fourth };
  shelf.push(peek(box, "arrival"));
  await pause();
  track(peek(box, "arrival"), "tracked");
  console.log("  attached");
  await pause();

  console.log("then with one callback on the promise: the derived promise is reported");
  const fifth = lost("fifth");
  shelf.push(pass(fifth));
  await pause();
  fifth.then((text: string) => {
    console.log("  never:", text);
  });
  console.log("  attached");
  await pause();

  console.log("handled in the same tick as the view: no report at all");
  const sixth = lost("sixth");
  shelf.push(pass(sixth));
  sixth.catch(note("caught at once"));
  await pause();

  console.log("reports:", reports, "late:", late, "views kept:", shelf.length);
}

await main();
