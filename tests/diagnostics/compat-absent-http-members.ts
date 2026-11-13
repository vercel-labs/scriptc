// node:http members scriptc does not implement, one use each: every
// statement below is refused by name. The compatibility ledger cites this
// program for marking the rows a verified absence instead of an
// unverified registry gap. The servers' inherited net.Server
// `[Symbol.asyncDispose]` no longer belongs here: it is implemented.
import * as http from "node:http";

// Agent: the socket hooks and the total-socket limit.
const agent = new http.Agent({ keepAlive: true });
console.log(typeof agent.createConnection, typeof agent.keepSocketAlive, typeof agent.reuseSocket);
console.log(agent.maxTotalSockets);
agent.destroy();

// Server: the request and response members. `[Symbol.asyncDispose]` is
// inherited from net.Server and implemented (net-server-dispose-http).
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

// The module: the proxy configuration read from the environment.
http.setGlobalProxyFromEnv();
