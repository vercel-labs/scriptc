// A net server and client whose handles, listeners and payloads are all
// typed: connection, data, end, close and the listening callback. Nothing
// here boxes a handle, so the program links none of the net unit's
// checked-dynamic members (tests/harness/corpus-dynamic-tier.test.ts).
import * as net from "node:net";

const lines: string[] = [];

const server = net.createServer((socket: net.Socket) => {
  lines.push("server: connection");
  socket.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8").trim();
    lines.push(`server: data ${text}`);
    socket.write(`echo ${text}\n`);
  });
  socket.on("end", () => {
    lines.push("server: end");
    socket.end("bye\n");
  });
  socket.on("close", () => {
    lines.push("server: close");
    server.close();
  });
});

server.on("close", () => {
  lines.push("server: closed");
  for (const line of lines) console.log(line);
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  lines.push(`listening ${address.address} ${address.family} ${address.port > 0}`);
  const client = net.connect(address.port, "127.0.0.1", () => {
    lines.push("client: connect");
    client.write("one\n");
  });
  let received = "";
  client.on("data", (chunk: Buffer) => {
    received += chunk.toString("utf8");
    if (received === "echo one\n") client.end();
  });
  client.on("end", () => lines.push("client: end"));
  client.on("close", () => {
    lines.push(`client: close ${JSON.stringify(received)}`);
  });
});
