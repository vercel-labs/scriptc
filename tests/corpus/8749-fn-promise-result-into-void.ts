// Promise results where the slot declares less: `() => Promise<T>` in a
// `() => void` slot is fired and forgotten, and a promise of an untyped,
// undefined or never value in a `() => Promise<void>` slot is the same
// promise: it settles when the original does and rejects with its reason.
let calls = 0;
const order: string[] = [];

const later = async (): Promise<number> => {
  calls++;
  order.push("later " + calls);
  return calls;
};
const loose = async (): Promise<any> => {
  calls++;
  if (calls % 7 === 0) throw new Error("rejected at " + calls);
  return "value " + calls;
};
const never = async (): Promise<never> => {
  calls++;
  throw new Error("always at " + calls);
};
const undef = async (): Promise<undefined> => {
  calls++;
  return undefined;
};
const slow = (): Promise<any> =>
  new Promise((resolve) => {
    setTimeout(() => {
      order.push("slow settled");
      resolve({ done: true });
    }, 5);
  });

const fire: () => void = later;
const quiet: () => Promise<void> = loose;
const quietNever: () => Promise<void> = never;
const quietUndef: () => Promise<void> = undef;
const quietSlow: () => Promise<void> = slow;

class Task {
  readonly run: () => Promise<void>;
  constructor(run: () => Promise<void>) {
    this.run = run;
  }
}

async function main(): Promise<void> {
  fire();
  fire();
  console.log("fired", calls, order.join(" | "));

  const settled = quiet();
  console.log("promise", settled instanceof Promise);
  await settled;
  await quiet();
  console.log("awaited", calls);

  // The slow promise settles before the code after its await runs.
  const waiting = quietSlow();
  order.push("waiting");
  await waiting;
  order.push("after slow");
  console.log(order.slice(2).join(" | "));

  for (const task of [new Task(loose), new Task(never), new Task(undef)]) {
    try {
      await task.run();
      console.log("task ok", calls);
    } catch (error) {
      console.log("task threw", (error as Error).message);
    }
  }
  try {
    await quietNever();
  } catch (error) {
    console.log("never threw", (error as Error).message);
  }
  await quietUndef();

  let rejected = 0;
  for (let i = 0; i < 200; i++) {
    try {
      await quiet();
    } catch {
      rejected++;
    }
  }
  console.log("loop", calls, rejected);

  // An unhandled-style chain: the rejection reaches a later handler.
  const caught = await quietNever().then(
    () => "fulfilled",
    (reason: Error) => "handler saw " + reason.message,
  );
  console.log(caught);

  let maybe: (() => Promise<void>) | undefined;
  console.log("unset", maybe === undefined);
  maybe = loose;
  if (maybe) await maybe();
  console.log(
    "same",
    quiet === loose,
    quietNever === never,
    quietUndef === undef,
    fire === later,
    maybe === loose,
  );
}
main();
