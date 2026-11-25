// node:http's request/response classes as values and as the identities of
// the instances a server hands its handler: the class values are functions
// carrying their prototype object, and instanceof answers both ways.
import http from "node:http";

console.log(
  "class",
  typeof http.IncomingMessage,
  http.IncomingMessage.name,
  http.IncomingMessage.length,
);
console.log(
  "server class",
  typeof http.ServerResponse,
  http.ServerResponse.name,
  http.ServerResponse.length,
);
console.log("prototype", typeof http.IncomingMessage.prototype, typeof http.ServerResponse.prototype);
console.log(
  "constructor",
  http.IncomingMessage.prototype.constructor === http.IncomingMessage,
  http.ServerResponse.prototype.constructor === http.ServerResponse,
);

await new Promise((resolve) => {
  const server = http.createServer((request, response) => {
    console.log("instanceof", request instanceof http.IncomingMessage, response instanceof http.ServerResponse);
    console.log("negative", request instanceof http.ServerResponse, response instanceof http.IncomingMessage);
    console.log(
      "identity",
      request.constructor === http.IncomingMessage,
      response.constructor === http.ServerResponse,
    );
    console.log("ordinary", ({}) instanceof http.IncomingMessage, [] instanceof http.ServerResponse);
    response.end("ok");
  });
  server.listen(0, "127.0.0.1", () => {
    const client = http.get({ host: "127.0.0.1", port: server.address().port, path: "/" }, (response) => {
      response.resume();
      response.on("end", () => server.close(() => resolve(undefined)));
    });
    client.on("error", () => server.close(() => resolve(undefined)));
  });
});
