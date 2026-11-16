// node:http members scriptc does not implement, one use each: every
// statement below is refused by name. The compatibility ledger cites this
// program for marking the rows a verified absence instead of an
// unverified registry gap. Implemented members leave this program:
// net.Server's `[Symbol.asyncDispose]`, OutgoingMessage's setHeaders,
// writableLength and 'drain', and OutgoingMessage.pipe() have their own
// differential programs.
import * as http from "node:http";

// Agent: the socket hooks and the total-socket limit.
const agent = new http.Agent({ keepAlive: true });
console.log(typeof agent.createConnection, typeof agent.keepSocketAlive, typeof agent.reuseSocket);
console.log(agent.maxTotalSockets);
agent.destroy();

// Server: the request and response members. `[Symbol.asyncDispose]` is
// inherited from net.Server and implemented (net-server-dispose-http), and
// IncomingMessage's abort signal has its own differential program
// (http-incoming-signal).
const server = http.createServer((request, response) => {
  // OutgoingMessage: an arbitrary 1xx response.
  response.writeInformation(103, { link: "</a.css>; rel=preload" });
  response.end();
});

// The module: the proxy configuration read from the environment.
http.setGlobalProxyFromEnv();
