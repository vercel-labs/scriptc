// The net.Server and net.Socket members that answer the receiver — Node's
// chaining — plus setEncoding's utf8 default and setKeepAlive's four
// positional arguments and options object. Server ref/unref/close and
// socket ref/unref/setEncoding/setTimeout/setNoDelay/setKeepAlive/pause/
// resume/end/destroy all return the handle they were called on; the
// setKeepAlive object form reads enable/initialDelay/interval/count, and
// its ToNumber hooks run the value's valueOf (a throwing one surfaces from
// the call, as Node's ~~ does). Every line prints from the server's side of
// the connection, or after the client's 'end', so the loopback race between
// the server's 'connection' and the client's 'connect' cannot reorder them.
import * as net from "node:net";

const trap: any = {
  valueOf(): number {
    throw new Error("nope");
  },
};

let reported = false;
const server = net.createServer((sock) => {
  // The scratch connection the client opens before closing the server is
  // accepted too; only the first connection reports.
  if (reported) {
    sock.destroy();
    return;
  }
  reported = true;
  console.log("socket ref chains:", sock.ref() === sock);
  console.log("socket unref chains:", sock.unref() === sock);
  console.log("socket setEncoding() chains:", sock.setEncoding() === sock);
  console.log("socket setEncoding(undefined) chains:", sock.setEncoding(undefined) === sock);
  const maybe: string | undefined = undefined;
  console.log("socket setEncoding(optional) chains:", sock.setEncoding(maybe) === sock);
  console.log("socket setNoDelay() chains:", sock.setNoDelay() === sock);
  console.log("socket setNoDelay(undefined) chains:", sock.setNoDelay(undefined) === sock);
  console.log("socket setNoDelay(false) chains:", sock.setNoDelay(false) === sock);
  console.log("socket setKeepAlive() chains:", sock.setKeepAlive() === sock);
  console.log("socket setKeepAlive(true) chains:", sock.setKeepAlive(true) === sock);
  console.log("socket setKeepAlive(true, 1000) chains:", sock.setKeepAlive(true, 1000) === sock);
  console.log("socket setKeepAlive(4 args) chains:", sock.setKeepAlive(true, 1000, 500, 7) === sock);
  console.log(
    "socket setKeepAlive(options) chains:",
    sock.setKeepAlive({ enable: true, initialDelay: 2000, interval: 1000, count: 3 }) === sock,
  );
  console.log("socket setKeepAlive(null) chains:", sock.setKeepAlive(null as any) === sock);
  console.log("socket setKeepAlive(NaN delay) chains:", sock.setKeepAlive(true, NaN) === sock);
  console.log('socket setKeepAlive("yes") chains:', sock.setKeepAlive("yes" as any) === sock);
  console.log("socket setTimeout() chains:", sock.setTimeout(0) === sock);
  console.log("socket pause/resume chain:", sock.pause() === sock, sock.resume() === sock);
  try {
    sock.setKeepAlive(true, trap);
  } catch (error: any) {
    console.log("setKeepAlive delay hook:", error.name, error.message);
  }
  sock.on("data", (chunk: string) => {
    console.log("server chunk:", typeof chunk, chunk);
    console.log("socket end chains:", sock.end("bye") === sock);
  });
});

console.log("server ref chains:", server.ref() === server);
console.log("server unref chains:", server.unref() === server);
server.listen(0, "127.0.0.1", () => {
  console.log("server ref while listening chains:", server.ref() === server);
  const port = (server.address() as net.AddressInfo).port;
  const client = net.connect(port, "127.0.0.1");
  client.on("connect", () => {
    client.write("ping");
  });
  client.on("error", () => {});
  client.setEncoding();
  client.on("data", (chunk: string) => {
    console.log("client chunk:", typeof chunk, chunk);
  });
  client.on("end", () => {
    console.log("client end");
  });
  client.on("close", () => {
    const scratch = net.connect(port, "127.0.0.1");
    scratch.on("error", () => {});
    console.log("scratch destroy chains:", scratch.destroy() === scratch);
    scratch.on("close", () => {
      console.log("server close chains:", server.close() === server);
    });
  });
});
