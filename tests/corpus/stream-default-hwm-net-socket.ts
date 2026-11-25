// The stream default highWaterMark reaches a net socket created after the
// change: the socket takes it at construction, so a write past it answers
// false where the old 64 KiB accepted it. An http response keeps the
// highWaterMark it was created with after its connection detaches.
import { createServer, get } from "node:http";
import type { ServerResponse } from "node:http";
import { connect } from "node:net";
import { setDefaultHighWaterMark } from "node:stream";

const log: string[] = [];

const early = connect({ port: 1 });
early.on("error", () => {});
log.push(`early write 2048 ${early.write(Buffer.alloc(2048))}`);
early.destroy();

setDefaultHighWaterMark(false, 1024);

const socket = connect({ port: 1 });
socket.on("error", () => {});
log.push(`socket write 512 ${socket.write(Buffer.alloc(512))}`);
log.push(`socket write 2048 ${socket.write(Buffer.alloc(2048))}`);
socket.destroy();

// A server created after the change takes the default for its responses,
// and a response keeps that value after its connection detaches.
let saved: ServerResponse | null = null;
const server = createServer((request, response) => {
  saved = response;
  log.push(`response hwm ${response.writableHighWaterMark}`);
  response.end("ok");
});

async function main(): Promise<void> {
  await new Promise<void>((resolve) => {
    server.listen(0, () => resolve());
  });
  const address = server.address() as { port: number } | null;
  await new Promise<void>((resolve) => {
    const request = get({ port: address!.port, path: "/" }, (response) => {
      response.resume();
      response.on("end", () => resolve());
    });
    request.on("error", () => resolve());
  });
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  setDefaultHighWaterMark(false, 4096);
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  log.push(`detached response hwm ${saved!.writableHighWaterMark}`);
  for (const line of log) console.log(line);
}

main();
