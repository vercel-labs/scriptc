// A write that answers false arms the message's 'drain' on the socket's
// flush — but the message's own corked bytes do not leave with that flush.
// With a corked chunk waiting while the peer drains an earlier large write,
// the socket flush must not leave a waiter armed for bytes it will never see:
// the timers below keep running, the corked bytes go out at the uncork, and
// the request ends.
import * as http from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";

const server = net.createServer((sock) => {
  sock.pause();
  setTimeout(() => {
    console.log("peer resume");
    sock.resume();
  }, 100);
  sock.on("data", () => {});
  sock.on("error", () => {});
});

server.listen(0, "127.0.0.1", () => {
  const request = http.request({
    port: (server.address() as AddressInfo).port,
    host: "127.0.0.1",
    method: "POST",
  });
  request.on("error", () => {});
  request.on("drain", () => console.log("drain"));
  request.write("a".repeat(4 << 20));
  setTimeout(() => {
    console.log("cork");
    request.cork();
    request.write("b");
  }, 25);
  setTimeout(() => {
    console.log("uncork");
    request.uncork();
  }, 200);
  setTimeout(() => {
    console.log("end");
    request.end();
    setTimeout(() => {
      request.destroy();
      server.close();
    }, 100);
  }, 300);
});
