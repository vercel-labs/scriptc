// write(data, encoding[, callback]) and end(data, encoding[, callback]):
// the bytes each string encoding produces, a Buffer chunk ignoring the
// encoding, Node's unknown-encoding error, and the flush/finish callbacks.
import * as net from "node:net";

function attempt(label: string, op: () => unknown): void {
  try {
    op();
    console.log(label, "ok");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log(label, "throws", err.name, err.code, err.message);
  }
}

const chunks: Buffer[] = [];
const server = net.createServer((socket) => {
  socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  socket.on("end", () => {
    console.log("received", Buffer.concat(chunks).toString("hex"));
    socket.end();
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

await new Promise<void>((resolve) => {
  const socket = new net.Socket();
  socket.on("close", () => resolve());
  socket.connect((server.address() as net.AddressInfo).port, "127.0.0.1", () => {
    console.log("hex", socket.write("6869", "hex"));
    console.log("base64", socket.write("aGk=", "base64"));
    console.log("latin1", socket.write("café", "latin1"));
    console.log("utf16le", socket.write("hi", "utf16le"));
    console.log("buffer encoding ignored", socket.write(Buffer.from("raw"), "base64"));
    attempt("unknown encoding", () => socket.write("x", "nope"));
    socket.end("bye", "utf8", () => console.log("finished"));
  });
});

server.close();
