// A 'keylog' listener on a plain net or HTTP server is inert, as Node's
// EventEmitter keeps a listener for any event name: registering it neither
// throws nor holds the process open. The TLS servers' logs are the other
// programs' business.
import * as net from "node:net";
import * as http from "node:http";

const plain = net.createServer();
plain.on("keylog", (line: Buffer) => console.log("plain", line.length));
plain.once("keylog", (line: Buffer) => console.log("plain once", line.length));
console.log("net registered");

const web = http.createServer();
web.on("keylog", (line: Buffer) => console.log("http", line.length));
console.log("http registered");
