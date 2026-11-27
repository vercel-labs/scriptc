// The response half of the drain rule: a write that answers false arms the
// message's 'drain', and a chunk corked while the client is still draining
// the earlier body must not leave a socket waiter armed for bytes the socket
// does not hold. Node's 'drain' comes when the uncork empties the message
// buffer, and the timers in between keep running.
import * as http from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";

const server = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.on("drain", () => console.log("drain"));
    console.log("write", res.write("a".repeat(4 << 20)));
    setTimeout(() => {
      console.log("cork");
      res.cork();
      res.write("b");
    }, 25);
    setTimeout(() => {
      console.log("uncork");
      res.uncork();
      res.end();
    }, 400);
  });
});

server.listen(0, "127.0.0.1", () => {
  const sock = net.connect((server.address() as AddressInfo).port, "127.0.0.1", () => {
    sock.write("GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    sock.pause();
    setTimeout(() => {
      console.log("client resume");
      sock.resume();
    }, 200);
  });
  sock.on("data", () => {});
  sock.on("close", () => {
    console.log("client close");
    server.close();
  });
  sock.on("error", () => {});
});
