// @exit: 1
// A stackless async body that rejects after suspending with nobody
// observing its promise: the rejection reaches Node's unhandled-rejection
// path once the microtask checkpoint completes, after the work already
// queued ahead of it, and the process exits with status 1.
async function failLater(label: string): Promise<number> {
  console.log("start", label);
  await Promise.resolve();
  console.log("resumed", label);
  await null;
  throw new Error("unhandled " + label);
}

async function fine(): Promise<void> {
  await null;
  console.log("fine done");
}

void fine();
void failLater("x");
setTimeout(() => console.log("timer never runs"), 5);
console.log("main done");
