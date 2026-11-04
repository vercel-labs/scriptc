// Web stream callbacks may answer a non-promise thenable instead of a
// promise: the start, pull and cancel results all go through the resolution
// procedure, so a record with a `then` method settles the callback exactly as
// an adopted promise would. The sources are plain objects, so their callbacks
// reach the runtime through the dynamic boundary, where a record result is a
// live typed capsule rather than a plain dynamic object.

const log: string[] = [];

let pulls = 0;
const source = {
  start(controller: ReadableStreamDefaultController<number>) {
    log.push("start");
    controller.enqueue(0);
    return {
      then(resolve: () => void): void {
        log.push("start then");
        process.nextTick(() => {
          log.push("start settled");
          resolve();
        });
      },
    };
  },
  pull(controller: ReadableStreamDefaultController<number>) {
    const n = ++pulls;
    log.push(`pull ${n}`);
    controller.enqueue(n);
    if (n === 2) controller.close();
    return {
      then(resolve: () => void): void {
        log.push(`pull then ${n}`);
        process.nextTick(() => {
          log.push(`pull settled ${n}`);
          resolve();
        });
      },
    };
  },
};
const reader = new ReadableStream<number>(source).getReader();
for (;;) {
  const result = await reader.read();
  if (result.done) break;
  log.push(`read ${result.value}`);
}
log.push("source done");

const canceled = {
  pull(controller: ReadableStreamDefaultController<number>) {
    controller.enqueue(1);
  },
  cancel() {
    log.push("cancel");
    return {
      then(resolve: () => void): void {
        log.push("cancel then");
        process.nextTick(() => {
          log.push("cancel settled");
          resolve();
        });
      },
    };
  },
};
const cancelReader = new ReadableStream<number>(canceled).getReader();
await cancelReader.cancel("stop");
log.push("cancel awaited");

for (const line of log) console.log(line);
