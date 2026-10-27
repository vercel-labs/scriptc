// node:http2 listeners registered with once and addListener on the server,
// the client session and both stream kinds. A once listener runs for the
// first event only; addListener is on.
import * as http2 from "node:http2";
import * as net from "node:net";

const log: string[] = [];
const accepted: string[] = [];
const server = http2.createServer();
server.once("connection", (socket: net.Socket) => accepted.push(`connection ${typeof socket.remotePort}`));
server.addListener("session", () => accepted.push("session"));
server.once("stream", () => log.push("server first stream"));
server.addListener("stream", (stream, headers) => {
  const header = headers[":path"];
  const path = typeof header === "string" ? header : "";
  log.push(`server stream ${path}`);
  let body = "";
  stream.addListener("data", (chunk) => (body += chunk.toString()));
  stream.once("end", () => {
    stream.respond({ ":status": 200, "x-path": path });
    stream.end(`${path}:${body}`);
  });
});
server.once("close", () => log.push("server close"));

function request(client: http2.ClientHttp2Session, path: string, body: string): Promise<string> {
  return new Promise((resolve) => {
    const req = client.request({ ":path": path, ":method": "POST" });
    req.once("response", (headers) => {
      const status = headers[":status"];
      const echoed = headers["x-path"];
      log.push(`client response ${typeof status === "number" ? status : "?"} ${typeof echoed === "string" ? echoed : "?"}`);
    });
    let text = "";
    req.addListener("data", (chunk) => (text += chunk.toString()));
    req.once("end", () => resolve(text));
    req.end(body);
  });
}

server.listen(0, () => {
  const port = (server.address() as net.AddressInfo).port;
  const client = http2.connect(`http://localhost:${port}`);
  client.once("connect", () => log.push("client connect"));
  client.addListener("close", () => {
    log.push("client close");
    server.close(() => console.log([accepted.sort().join(", "), ...log].join("\n")));
  });
  void (async () => {
    console.log(await request(client, "/a", "one"));
    console.log(await request(client, "/b", "two"));
    client.close();
  })();
});
