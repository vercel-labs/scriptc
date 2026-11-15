// A promise that passes through an untyped position is still one promise.
// A rejection handled on the promise, or through the untyped value, is
// handled, whichever comes first and whether the promise had settled when
// it crossed; a rejection nobody handles is reported once.
export {};

let reports = 0;
process.on("unhandledRejection", (reason, promise) => {
  reports += 1;
  console.log("unhandled:", String(reason), promise instanceof Promise);
});

function pause(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 2);
  });
}

function describe(value: unknown): string {
  return value instanceof Promise ? "a promise" : typeof value;
}

function hold(values: unknown[], value: unknown): number {
  values.push(value);
  return values.length;
}

function nameOf(names: Map<Promise<unknown>, string>, key: Promise<unknown>, name: string): string {
  const known = names.get(key);
  if (known !== undefined) return known;
  names.set(key, name);
  return name;
}

function handleThrough(value: unknown, label: string): void {
  if (value instanceof Promise) {
    value.then(undefined, (reason: unknown) => {
      console.log(label, "handled through the untyped value:", String(reason));
    });
  }
}

function failLater(reason: string): Promise<number> {
  return new Promise<number>((_resolve, reject) => {
    setTimeout(() => {
      reject(new Error(reason));
    }, 1);
  });
}

async function failAsync(reason: string): Promise<number> {
  await Promise.resolve();
  throw new Error(reason);
}

async function main(): Promise<void> {
  const kept: unknown[] = [];

  // Handled on the promise first, passed on after it settled.
  const early: Promise<number> = Promise.reject("early");
  early.then(
    () => {
      console.log("early fulfilled");
    },
    (reason) => {
      console.log("early handled:", reason);
    },
  );
  await pause();
  console.log("early", describe(early), hold(kept, early));

  // Passed on first, handled on the promise in the same turn.
  const sameTurn: Promise<number> = Promise.reject("same turn");
  console.log("same turn", describe(sameTurn), hold(kept, sameTurn));
  sameTurn.catch((reason) => {
    console.log("same turn handled:", reason);
  });
  await pause();

  // Handled only through the untyped value.
  const through: Promise<number> = Promise.reject("through");
  handleThrough(through, "through");
  await pause();

  // Pending while it crosses, rejected and handled later.
  const later = failLater("later");
  console.log("later", describe(later), hold(kept, later));
  later.catch((reason) => {
    console.log("later handled:", String(reason));
  });
  await pause();

  const pendingThrough = failLater("pending through");
  handleThrough(pendingThrough, "pending");
  await pause();

  // The promise of an async function, awaited after it crossed.
  const awaited = failAsync("awaited");
  console.log("awaited", describe(awaited), hold(kept, awaited));
  try {
    await awaited;
  } catch (error) {
    console.log("awaited caught:", error instanceof Error ? error.message : "other");
  }

  // Handled, then thrown and caught.
  const thrown: Promise<number> = Promise.reject("thrown");
  thrown.catch(() => {});
  try {
    throw thrown;
  } catch (caught: unknown) {
    console.log("thrown", caught instanceof Promise, caught === thrown);
  }
  await pause();

  // Handled, settled, then a key of a map of untyped promises.
  const names = new Map<Promise<unknown>, string>();
  const keyed: Promise<number> = Promise.reject("keyed");
  keyed.catch(() => {});
  await pause();
  console.log("map", nameOf(names, keyed, "keyed"), nameOf(names, keyed, "again"), names.size);

  // A fulfilled promise crosses with its value.
  const fine: Promise<number> = Promise.resolve(7);
  const fineHeld: unknown = fine;
  if (fineHeld instanceof Promise) {
    console.log("fine", await fineHeld);
  }

  console.log("reports so far", reports);

  // Nobody handles these: each is reported once.
  const lost: Promise<number> = Promise.reject("lost");
  console.log("lost", describe(lost), hold(kept, lost));
  await pause();
  const lostLater = failLater("lost later");
  console.log("lost later", describe(lostLater), hold(kept, lostLater));
  await pause();
  await pause();
  console.log("reports", reports, kept.length);
}

main();
