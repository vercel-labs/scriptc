// server.setTimeout([msecs][, callback]): the optional milliseconds, the
// callback-only form the Node types declare, and the chainable answer.
import * as http from "node:http";

const server = http.createServer((request, response) => {
  console.log("request", request.url);
  response.end("ok");
});

console.log("no args", server.setTimeout() === server);
console.log("undefined msecs", server.setTimeout(undefined, (socket) => console.log("unused", socket.destroyed)) === server);
console.log("callback only", server.setTimeout((socket) => console.log("idle", socket.destroyed)) === server);
console.log("plain msecs", server.setTimeout(50) === server);

server.listen(0, "127.0.0.1", () => {
  const client = http.request({ host: "127.0.0.1", port: server.address().port, path: "/ok" }, (response) => {
    response.resume();
    response.on("end", () => {
      console.log("client done", response.statusCode);
      server.close(() => console.log("closed"));
    });
  });
  client.on("error", () => console.log("client error"));
  client.end();
});
