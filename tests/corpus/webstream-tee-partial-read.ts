// A byte-stream tee whose branch reads through a multi-byte BYOB view: when
// the source ends with a partial element outstanding, the branch's read
// rejects with Node's "Partial read" TypeError and the tee's internal EOF
// handling must not surface that as an uncaught exception. A plain byte
// stream's own close() still throws to its caller.
function describe(error: unknown): string {
  const e = error as { code?: string; message?: string };
  return `${e.code}:${e.message}`;
}

function settle(p: Promise<unknown>): Promise<string> {
  return p.then(
    () => "resolved",
    (error: unknown) => `rejected:${describe(error)}`,
  );
}

function main(): Promise<void> {
  return new Promise<void>((resolve) => {
    let controller!: ReadableByteStreamController;
    const source = new ReadableStream({
      type: "bytes",
      start(c: ReadableByteStreamController): void {
        controller = c;
      },
    });
    const branches = source.tee();
    const first = branches[0];
    const second = branches[1];
    const reader = first.getReader({ mode: "byob" });
    const pending = reader.read(new Uint32Array(2));
    controller.enqueue(new Uint8Array([1, 2]));
    controller.close();
    settle(pending)
      .then((outcome) => {
        console.log("tee read", outcome);
        return second.getReader().read();
      })
      .then((chunk) => {
        console.log(
          "other branch",
          chunk.done,
          chunk.value instanceof Uint8Array ? Array.from(chunk.value).join(",") : "-",
        );
        resolve();
      });
  }).then(() => {
    let controller!: ReadableByteStreamController;
    const stream = new ReadableStream({
      type: "bytes",
      start(c: ReadableByteStreamController): void {
        controller = c;
      },
    });
    const reader = stream.getReader({ mode: "byob" });
    const pending = reader.read(new Uint32Array(2));
    controller.enqueue(new Uint8Array([3, 4]));
    try {
      controller.close();
      console.log("plain close threw false");
    } catch (error: unknown) {
      console.log("plain close threw", describe(error));
    }
    return settle(pending).then((outcome) => {
      console.log("plain read", outcome);
    });
  });
}

main().then(() => undefined);
