// node:http members scriptc does not implement, one use each: every
// statement below is refused by name. The compatibility ledger cites this
// program for marking the rows a verified absence instead of an
// unverified registry gap. Implemented members leave this program:
// net.Server's `[Symbol.asyncDispose]`, IncomingMessage's signal,
// OutgoingMessage's setHeaders, writableLength and 'drain',
// OutgoingMessage.pipe(), the informational responses (writeInformation
// and the three that delegate to it), the agent's keepSocketAlive and
// reuseSocket hooks, and maxTotalSockets have their own differential
// programs.
import * as http from "node:http";

// Agent: the dial hook.
const agent = new http.Agent({ keepAlive: true });
console.log(typeof agent.createConnection);
agent.destroy();

// Server: the request and response members. `[Symbol.asyncDispose]` is
// inherited from net.Server and implemented (net-server-dispose-http).
const server = http.createServer((request, response) => {
  response.end();
});

// The module: the proxy configuration read from the environment.
http.setGlobalProxyFromEnv();
