// A class whose methods emit with fixed tuples, observed by listeners
// registered through untyped references: class-instance payloads keep
// their identity, once/off apply across typed and untyped listeners, a
// listener may capture and remove itself, untyped emits reach events.once,
// and errorMonitor sees untyped 'error' emits.
import { EventEmitter, once, errorMonitor } from "node:events";

class Job {
  readonly tags: string[] = [];
  readonly id: number;
  constructor(id: number) {
    this.id = id;
  }
}

class Worker extends EventEmitter {
  run(job: Job): void {
    this.emit("job", job, job.tags.length);
  }
  finish(): void {
    this.emit("done");
  }
}

const w = new Worker();
const u: any = w;
const first = new Job(7);
u.on("job", (j: any, count: any) => {
  console.log("untyped job", j.id, count, j === first, j instanceof Job);
  j.tags.push("seen");
});
w.on("job", (j: Job) => console.log("typed job", j.id, j.tags.join(",")));
u.once("done", () => console.log("done once"));
w.run(first);
w.finish();
w.finish();
u.emit("job", new Job(8), 0);
const self = (): void => {
  console.log("self", u.listenerCount("job"));
  u.off("job", self);
};
u.on("job", self);
w.run(new Job(9));
w.run(new Job(10));
w.on(errorMonitor, (err: Error) => console.log("monitor", err.message));
w.on("error", (err: Error) => console.log("typed error", err.message));
u.emit("error", new Error("e1"));
async function main(): Promise<void> {
  const pending = once(w, "job");
  u.emit("job", new Job(11), 1);
  const [j, count]: any[] = await pending;
  console.log("once resolved", j.id, count);
}
main();
