// Values typed by the library's PromiseLike<T>: a slot of that type holds
// whatever has a `then` method, a promise or an object of the program. The
// program awaits it, hands it to Promise.resolve and to the combinators, and
// calls its `then` itself, and each of these asks the value as JavaScript
// does: a promise is itself, a thenable's `then` is called one job later
// (or at once when the program calls it), and what it hands over is checked
// against the declared type. The tick counter pins the microtask order.
let tick = 0;
function spin(i: number): void {
  if (i < 30) {
    Promise.resolve().then(() => {
      tick++;
      spin(i + 1);
    });
  }
}

function text(v: unknown): string {
  if (v instanceof Error) return "Error(" + v.message + ")";
  return typeof v + ":" + String(v);
}

interface Task {
  readonly name: string;
  readonly work: PromiseLike<number>;
}

// An object of the program with a `then` method: it answers a job later.
function delayed(n: number): PromiseLike<number> {
  return {
    then<A, B>(onFulfilled?: ((value: number) => A | PromiseLike<A>) | null): PromiseLike<A | B> {
      console.log("  delayed.then called at tick", tick);
      return Promise.resolve(n).then(onFulfilled);
    },
  };
}

// Calls back twice, then rejects: only the first call counts.
function eager(): PromiseLike<number> {
  return {
    then(onFulfilled?: ((value: number) => any) | null, onRejected?: ((reason: any) => any) | null): PromiseLike<any> {
      console.log("  eager.then called at tick", tick);
      if (onFulfilled) {
        onFulfilled(1);
        onFulfilled(2);
      }
      if (onRejected) onRejected(new Error("late"));
      return Promise.resolve();
    },
  };
}

// A `then` that throws: the awaiting side sees the error.
function faulty(): PromiseLike<number> {
  return {
    then(): PromiseLike<never> {
      console.log("  faulty.then called at tick", tick);
      throw new Error("then threw");
    },
  };
}

async function compute(n: number): Promise<number> {
  return n * 2;
}

async function awaited(label: string, work: PromiseLike<number>): Promise<void> {
  try {
    const got = await work;
    console.log(label, "await", text(got), "tick", tick);
  } catch (e) {
    console.log(label, "await threw", text(e), "tick", tick);
  }
}

function chained(work: PromiseLike<number>): PromiseLike<string> {
  return work.then(
    (value) => "value " + value,
    (reason: unknown) => "reason " + text(reason),
  );
}

function adopted(work: PromiseLike<number>): Promise<number> {
  return Promise.resolve(work);
}

function pick(flag: boolean): PromiseLike<number> {
  return flag ? Promise.resolve(5) : delayed(6);
}

async function either(work: number | PromiseLike<number>): Promise<string> {
  if (typeof work === "number") return "plain " + work;
  return "settled " + (await work);
}

async function main(): Promise<void> {
  spin(0);
  const quick = Promise.resolve(41);
  const failing: Promise<number> = Promise.reject(new Error("no value"));

  await awaited("promise", quick);
  await awaited("async result", compute(4));
  await awaited("rejected", failing);
  await awaited("delayed", delayed(7));
  await awaited("eager", eager());
  await awaited("faulty", faulty());

  console.log("chained", await chained(quick), "|", await chained(delayed(8)), "tick", tick);

  const same = adopted(quick);
  console.log("resolve keeps a promise", same === quick, await same);
  console.log("resolve adopts a thenable", await adopted(delayed(9)), "tick", tick);

  const tasks: Task[] = [
    { name: "a", work: quick },
    { name: "b", work: delayed(10) },
    { name: "c", work: compute(6) },
  ];
  for (const task of tasks) console.log("task", task.name, await task.work, "tick", tick);

  const list: PromiseLike<number>[] = [pick(true), pick(false)];
  const all = await Promise.all([list[0]!, list[1]!]);
  console.log("all", all.length, all[0], all[1], "tick", tick);
  console.log("race", await Promise.race([delayed(11), quick]), "tick", tick);

  console.log("either", await either(3), "|", await either(quick), "|", await either(delayed(12)));
  console.log("is a promise", pick(true) instanceof Promise, pick(false) instanceof Promise);
  console.log("end tick", tick);
}

main();
