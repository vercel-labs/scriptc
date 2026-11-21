// agent.getName's documented key shape: host:port:localAddress[:family]
// [:socketPath], with Node's defaults for the absent parts.
import * as http from "node:http";

const agent = new http.Agent({ keepAlive: true, maxSockets: 2 });
console.log("1", agent.getName({ host: "Example.COM", port: 8080 }));
console.log("2", agent.getName({ host: "::1", port: 80, family: 6 }));
console.log("3", agent.getName({ socketPath: "/tmp/s.sock" }));
console.log("4", agent.getName({ host: "h", port: 80, localAddress: "127.0.0.1" }));
console.log("5", JSON.stringify(agent.getName({})));
