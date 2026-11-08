// The microtask turn on which the tuple forms of Promise.all and
// Promise.allSettled settle, against a chain of four reactions started
// right after the call: an entry that is a promise or nothing (both arms),
// a plain record entry, a tuple-typed value, a Promise<unknown>[] array, a
// value or a promise of it, and the settled form with a rejection, a
// missing entry and a plain value. The extra bookkeeping an entry needs
// must not move the result by a turn.
const log: string[] = [];
const yes = process.argv.length < 99;

function tick(): Promise<void> {
  return Promise.resolve()
    .then(() => {
      log.push("t1");
    })
    .then(() => {
      log.push("t2");
    })
    .then(() => {
      log.push("t3");
    })
    .then(() => {
      log.push("t4");
    });
}

async function round(label: string, started: Promise<void>): Promise<void> {
  await Promise.all([started, tick()]);
  console.log(label, log.join(" "));
  log.length = 0;
}

async function main(): Promise<void> {
  const place = { shelf: "north" };
  await round(
    "promise arm:",
    Promise.all([Promise.resolve(1), yes ? Promise.resolve("x") : undefined]).then(([n, s]) => {
      log.push("all:" + n + s);
    }),
  );
  await round(
    "unit arm:",
    Promise.all([Promise.resolve(1), yes ? undefined : Promise.resolve("x")]).then(([n, s]) => {
      log.push("all:" + n + s);
    }),
  );
  await round(
    "plain record:",
    Promise.all([place, Promise.resolve(2)]).then(([r, n]) => {
      log.push("all:" + r.shelf + n);
    }),
  );
  const pair = [Promise.resolve(1), Promise.resolve("s")] as const;
  await round(
    "tuple value:",
    Promise.all(pair).then(([n, s]) => {
      log.push("all:" + n + s);
    }),
  );
  const unknowns: Promise<unknown>[] = [Promise.resolve(1), Promise.resolve("s")];
  await round(
    "unknown[]:",
    Promise.all(unknowns).then((rs) => {
      log.push("all:" + rs.length);
    }),
  );
  await round(
    "value or promise:",
    Promise.all([yes ? place : Promise.resolve(place), Promise.resolve(1)]).then(([r, n]) => {
      log.push("all:" + r.shelf + n);
    }),
  );
  await round(
    "value or promise, promise:",
    Promise.all([yes ? Promise.resolve(place) : place, Promise.resolve(1)]).then(([r, n]) => {
      log.push("all:" + r.shelf + n);
    }),
  );
  await round(
    "settled:",
    Promise.allSettled([
      Promise.resolve(1),
      yes ? Promise.reject(new Error("r")) : undefined,
      place,
    ]).then(([x, y, z]) => {
      log.push("settled:" + x.status[0] + y.status[0] + z.status[0]);
    }),
  );
  await round(
    "settled, pending entry:",
    Promise.allSettled([
      new Promise<number>((resolve) => setTimeout(() => resolve(1), 2)),
      Promise.resolve("s"),
    ]).then(([x, y]) => {
      log.push("settled:" + x.status[0] + y.status[0]);
    }),
  );
  // A later rejection of the tuple form is handled, like the first.
  process.on("unhandledRejection", (reason: unknown) => {
    console.log("unhandled:", reason instanceof Error ? reason.message : String(reason));
  });
  const slow = new Promise<number>((_, reject) => setTimeout(() => reject(new Error("slow")), 4));
  const fast = new Promise<string>((_, reject) => setTimeout(() => reject(new Error("fast")), 1));
  try {
    await Promise.all([slow, yes ? fast : undefined, place]);
  } catch (e) {
    console.log("caught", (e as Error).message);
  }
  await new Promise<void>((resolve) => setTimeout(() => resolve(), 8));
  console.log("end");
}

main().catch((e: unknown) => {
  console.log("main rejected:", e instanceof Error ? e.message : String(e));
});
