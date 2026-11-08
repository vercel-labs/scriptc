// node:http and node:https members scriptc does not implement, one use
// each: every statement below is refused by name. The compatibility
// ledger cites this program for marking the rows a verified absence
// instead of an unverified registry gap.
import * as http from "node:http";
import * as https from "node:https";

// Agent: the socket hooks and the total-socket limit.
const agent = new http.Agent({ keepAlive: true });
console.log(typeof agent.createConnection, typeof agent.keepSocketAlive, typeof agent.reuseSocket);
console.log(agent.maxTotalSockets);
agent.destroy();

// Server: the header-count and requests-per-socket limits, the event for
// a request the latter drops, and explicit resource management.
const server = http.createServer((request, response) => {
  // IncomingMessage: the abort signal.
  console.log(request.signal.aborted);
  // OutgoingMessage: several headers at once, an arbitrary 1xx response,
  // and the state and event behind write()'s result.
  response.setHeaders(new Map([["x-a", "1"]]));
  response.writeInformation(103, { link: "</a.css>; rel=preload" });
  console.log(response.writableLength);
  response.on("drain", () => {});
  response.end();
});
console.log(server.maxHeadersCount, server.maxRequestsPerSocket);
server.on("dropRequest", () => {});
await server[Symbol.asyncDispose]();

// ClientRequest: the header-count limit of the response.
const request = http.request({ host: "127.0.0.1", port: 1 });
console.log(request.maxHeadersCount);
request.destroy();

// The module: the proxy configuration read from the environment.
http.setGlobalProxyFromEnv();

// https: the same server members.
const secure = https.createServer({}, (_request, response) => response.end());
console.log(secure.maxHeadersCount);
await secure[Symbol.asyncDispose]();
