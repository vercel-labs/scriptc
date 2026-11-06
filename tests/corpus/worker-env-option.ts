// The Worker env option: an object's own enumerable entries, ToString-ed,
// become the worker's process.env; null or undefined copies this thread's
// environment; every other value is ERR_INVALID_ARG_TYPE. The conversion runs
// an object's Symbol.toPrimitive with the string hint, at construction, and
// its throw leaves the constructor. The copy belongs to the worker, so its
// writes do not reach the parent.
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

type Env = { [key: string]: string | number | boolean | undefined } | null;

function phase(mode: string, env?: Env): Worker {
  return env === undefined
    ? new Worker(new URL(import.meta.url), { workerData: mode })
    : new Worker(new URL(import.meta.url), { workerData: mode, env });
}

function report(label: string, error: unknown): void {
  const shape = error as { code?: string; message?: string };
  console.log(label, shape.code, shape.message);
}

/** A rejected env conversion: Node reports the hook's own throw (whatever
 * value it threw) or the object-to-primitive TypeError. */
function rejected(label: string, value: any): void {
  try {
    const options: any = { env: { PRIM: value } };
    new Worker(new URL(import.meta.url), options);
    console.log(label, "not thrown");
  } catch (error) {
    if (typeof error === "string") {
      console.log(label, "string", error);
      return;
    }
    const shape = error as { name?: string; message?: string };
    console.log(label, shape.name, shape.message);
  }
}

/** The values convert at construction, before the worker starts: the hook's
 * hint and result are visible, its throw escapes the constructor, and an
 * object it answers with is the object-to-primitive TypeError. */
function coercions(): void {
  const log: string[] = [];
  const hook: any = {
    [Symbol.toPrimitive](hint: string) {
      log.push("hint " + hint);
      return "from-primitive";
    },
    toString() {
      log.push("toString");
      return "from-toString";
    },
  };
  const options: any = { workerData: "coerced", env: { PRIM: hook } };
  const worker = new Worker(new URL(import.meta.url), options);
  worker.on("message", (message: unknown) => console.log("coerced:", message, "hook:", log.join(",")));
  worker.on("exit", (code: number) => {
    console.log("coerced exit:", code);
    rejected("throwing:", {
      [Symbol.toPrimitive]() {
        throw "thrown-by-hook";
      },
    });
    rejected("object answer:", {
      [Symbol.toPrimitive]() {
        return {};
      },
    });
  });
}

if (isMainThread) {
  process.env.PARENT_ONLY = "parent";
  // The rejections report before any worker starts: a started worker writes
  // to the same stdout, so its output could interleave.
  const reject = (env: any): void => {
    try {
      new Worker(new URL(import.meta.url), { env });
    } catch (error) {
      report("rejected:", error);
    }
  };
  reject("text");
  reject(Symbol("nope"));
  reject(5);
  reject(true);
  const copy = { A: "1", B: 2, C: true, D: undefined };
  const first = phase("object", copy);
  first.on("message", (message: unknown) => console.log("object:", message));
  first.on("exit", (code: number) => {
    console.log("object exit:", code, "parent A:", process.env.A, "parent WSET:", process.env.WSET);
    const second = phase("null", null);
    second.on("message", (message: unknown) => console.log("null:", message));
    second.on("exit", (code2: number) => {
      console.log("null exit:", code2, "parent WSET:", process.env.WSET);
      const third = phase("empty", {});
      third.on("message", (message: unknown) => console.log("empty:", message));
      third.on("exit", (code3: number) => {
        console.log("empty exit:", code3);
        const fourth = phase("omitted");
        fourth.on("message", (message: unknown) => console.log("omitted:", message));
        fourth.on("exit", (code4: number) => {
          console.log("omitted exit:", code4);
          coercions();
        });
      });
    });
  });
} else {
  const mode = workerData as string;
  if (mode === "object") {
    console.log(
      "worker entries:",
      process.env.A,
      process.env.B,
      process.env.C,
      process.env.D,
      "PATH absent:",
      process.env.PATH === undefined,
    );
    process.env.WSET = "worker";
    parentPort!.postMessage("done");
  } else if (mode === "null") {
    console.log(
      "worker copy:",
      process.env.PARENT_ONLY,
      "A absent:",
      process.env.A === undefined,
    );
    process.env.WSET = "null-worker";
    parentPort!.postMessage("done");
  } else if (mode === "empty") {
    console.log(
      "worker empty:",
      process.env.PARENT_ONLY === undefined,
      process.env.PATH === undefined,
    );
    parentPort!.postMessage("done");
  } else if (mode === "coerced") {
    parentPort!.postMessage(process.env.PRIM);
  } else {
    console.log("worker omitted:", process.env.PARENT_ONLY, process.env.A === undefined);
    parentPort!.postMessage("done");
  }
}
