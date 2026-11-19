import { Duplex } from "node:stream";

const log: string[] = [];

function readableFailure(): Promise<void> {
  return new Promise<void>((resolve) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const readable = new ReadableStream<Uint8Array>({
      start(c: ReadableStreamDefaultController<Uint8Array>): void {
        controller = c;
      },
    });
    const writable = new WritableStream<Uint8Array>({ write(): void {} });
    const duplex = Duplex.fromWeb({ readable, writable });
    duplex.on("error", (error: Error) => log.push(`readable error ${error.message}`));
    duplex.on("close", () => {
      log.push(`readable close destroyed=${duplex.destroyed}`);
      resolve();
    });
    controller.error(new Error("readable failed"));
  });
}

function writableFailure(): Promise<void> {
  return new Promise<void>((resolve) => {
    const readable = new ReadableStream<Uint8Array>({ pull(): void {} });
    let controller!: WritableStreamDefaultController;
    const writable = new WritableStream<Uint8Array>({
      start(c: WritableStreamDefaultController): void {
        controller = c;
      },
    });
    const duplex = Duplex.fromWeb({ readable, writable });
    duplex.on("error", (error: Error) => log.push(`writable error ${error.message}`));
    duplex.on("close", () => {
      log.push(`writable close destroyed=${duplex.destroyed}`);
      resolve();
    });
    controller.error(new Error("writable failed"));
  });
}

readableFailure()
  .then(() => writableFailure())
  .then(() => console.log(log.join("\n")));
