// Typed net handles that reach untyped code late: the server registers
// typed listeners first, then hands its socket and itself to functions that
// take `unknown` and work on them through `any`. The handle's dynamic
// members answer there (methods, properties, listeners, identity), though
// nothing dynamic touched the handles before.
import * as net from "node:net";

function describeSocket(value: unknown): string {
  const socket = value as any;
  return [
    typeof socket.write,
    typeof socket.remotePort,
    socket.remoteAddress,
    socket.destroyed,
    socket.readyState,
  ].join(" ");
}

function listenUntyped(value: unknown, log: string[]): void {
  const socket = value as any;
  socket.on("data", (chunk: any) => log.push(`untyped data ${String(chunk).trim()}`));
  socket.once("end", () => log.push("untyped end"));
}

function describeServer(value: unknown): string {
  const server = value as any;
  const address = server.address();
  return `${server.listening} ${typeof address.port} ${address.address} ${address.family}`;
}

const log: string[] = [];
const seen: unknown[] = [];

const server = net.createServer((socket: net.Socket) => {
  socket.on("data", (chunk: Buffer) => {
    log.push(`typed data ${chunk.toString().trim()}`);
  });
  log.push(`socket: ${describeSocket(socket)}`);
  listenUntyped(socket, log);
  seen.push(socket);
  const again: unknown = socket;
  log.push(`same handle ${seen[0] === again}`);
  (again as any).end("done\n");
  socket.on("close", () => {
    const untypedServer = server as unknown as any;
    untypedServer.close(() => {
      log.push("closed");
      for (const line of log) console.log(line);
    });
  });
});

server.listen(0, "127.0.0.1", () => {
  log.push(`server: ${describeServer(server)}`);
  const address = server.address() as net.AddressInfo;
  const client = net.connect(address.port, "127.0.0.1", () => client.end("ping\n"));
  client.resume();
});
