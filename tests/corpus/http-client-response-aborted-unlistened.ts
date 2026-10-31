// A client response cut off mid-body reports 'aborted' and 'close'; its
// 'error' reaches 'error' listeners only, so a response without one does not
// end the process. fetch relies on this when it leaves a redirect whose
// chunked body has not ended.
import * as http from "node:http";
import * as net from "node:net";

const server = net.createServer((socket) => {
  let buffered = "";
  socket.on("data", (chunk) => {
    buffered += chunk.toString("latin1");
    while (buffered.includes("\r\n\r\n")) {
      const end = buffered.indexOf("\r\n\r\n");
      const path = buffered.slice(0, end).split(" ")[1];
      buffered = buffered.slice(end + 4);
      if (path === "/final") {
        socket.write("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nfinal");
        continue;
      }
      socket.write("HTTP/1.1 303 See Other\r\nLocation: /final\r\nTransfer-Encoding: chunked\r\n\r\n");
      // The terminating chunk arrives in a later read.
      setTimeout(() => {
        if (!socket.destroyed) socket.write("0\r\n\r\n");
      }, 50);
    }
  });
  socket.on("error", () => {});
});

function destroyMidBody(port: number, listen: boolean): Promise<void> {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/start" }, (res) => {
      console.log("status", res.statusCode);
      res.on("aborted", () => console.log("aborted"));
      if (listen) res.on("error", (error: NodeJS.ErrnoException) => console.log("res error", error.message, error.code));
      res.on("close", () => {
        console.log("res close");
        resolve();
      });
      req.destroy();
    });
    req.on("close", () => console.log("req close"));
  });
}

server.listen(0, "127.0.0.1", async () => {
  const port = (server.address() as net.AddressInfo).port;
  const response = await fetch(`http://127.0.0.1:${port}/start`);
  console.log(response.status, response.redirected, response.url.endsWith("/final"), await response.text());
  await destroyMidBody(port, false);
  await destroyMidBody(port, true);
  server.close();
});
