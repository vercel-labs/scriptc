// The key order of a web stream read result from typed code: { done,
// value } for a read() that finds its chunk queued, { value, done } for
// one that waits and for the end.
function shape(result: ReadableStreamReadResult<string>): string {
  return `${Object.keys(result).join(",")} ${JSON.stringify(result)}`;
}

async function main(): Promise<void> {
  const queued = new ReadableStream<string>({
    start(controller) {
      controller.enqueue("a");
      controller.enqueue("b");
      controller.close();
    },
  });
  const reader = queued.getReader();
  console.log("queued", shape(await reader.read()), "|", shape(await reader.read()));
  console.log("end", shape(await reader.read()));

  let controller: ReadableStreamDefaultController<string> | undefined;
  const waiting = new ReadableStream<string>({
    start(c) {
      controller = c;
    },
  });
  const waitingReader = waiting.getReader();
  const first = waitingReader.read();
  const second = waitingReader.read();
  controller!.enqueue("a");
  controller!.close();
  console.log("waiting", shape(await first), "|", shape(await second));
}

main();
