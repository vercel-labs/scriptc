import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

// Messages queued for a thread while one of its 'message' listeners runs
// are delivered before the loop goes on to immediates, in both directions:
// worker to parent, and parent to worker. Microtasks a listener queues run
// before the next message. The first listener waits on a shared flag until
// the other thread has posted the rest, so they are queued before it
// returns.
type Setup = { role: "sender" | "receiver"; flag: Int32Array };

function waitFor(flag: Int32Array, index: number): void {
  while (Atomics.load(flag, index) === 0) Atomics.wait(flag, index, 0, 50);
}

function signal(flag: Int32Array, index: number): void {
  Atomics.store(flag, index, 1);
  Atomics.notify(flag, index);
}

/** Records the order of the batch the first message's listener waits for. */
function receive(on: (listener: (m: unknown) => void) => void, flag: Int32Array, done: (log: string[]) => void): void {
  const log: string[] = [];
  let count = 0;
  on((m) => {
    count++;
    log.push(`message ${String(m)}`);
    if (count === 1) {
      signal(flag, 0);
      waitFor(flag, 1);
      process.nextTick(() => log.push("tick"));
      queueMicrotask(() => log.push("microtask"));
      setImmediate(() => {
        log.push("immediate");
        done(log);
      });
    }
    if (count === 4) queueMicrotask(() => log.push(`microtask after ${String(m)}`));
  });
}

function send(post: (m: string) => void, flag: Int32Array, prefix: string): void {
  post(`${prefix}1`);
  waitFor(flag, 0);
  for (let i = 2; i <= 6; i++) post(`${prefix}${i}`);
  signal(flag, 1);
}

if (isMainThread) {
  // Worker to parent: the worker sends, this thread receives.
  const first = new Int32Array(new SharedArrayBuffer(8));
  const sender = new Worker(new URL(import.meta.url), { workerData: { role: "sender", flag: first } satisfies Setup });
  receive(
    (listener) => sender.on("message", listener),
    first,
    (log) => {
      console.log("worker to parent");
      for (const line of log) console.log(line);
    },
  );
  sender.on("exit", () => {
    // Parent to worker: this thread sends, the worker receives and reports its log.
    const second = new Int32Array(new SharedArrayBuffer(8));
    const receiver = new Worker(new URL(import.meta.url), {
      workerData: { role: "receiver", flag: second } satisfies Setup,
    });
    receiver.on("message", (log: unknown) => {
      if (!Array.isArray(log)) return;
      console.log("parent to worker");
      for (const line of log) console.log(String(line));
    });
    receiver.on("online", () => send((m) => receiver.postMessage(m), second, "p"));
    receiver.on("exit", (code: number) => console.log("exit", code));
  });
} else {
  const setup = workerData as Setup;
  const port = parentPort!;
  if (setup.role === "sender") send((m) => port.postMessage(m), setup.flag, "w");
  else
    receive(
      (listener) => port.on("message", listener),
      setup.flag,
      (log) => {
        port.postMessage(log);
        port.close();
      },
    );
}
