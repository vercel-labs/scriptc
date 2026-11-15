// The header surface http.ServerResponse inherits from OutgoingMessage
// (appendHeader, getHeaderNames, getHeaders, hasHeader, removeHeader),
// its 'finish' event, writableFinished and socket, the request's own
// 'finish', and the Agent classes of http and https.
import { Agent, createServer, globalAgent, request } from "node:http";
import { Agent as HttpsAgent, globalAgent as httpsGlobalAgent } from "node:https";
import type { AddressInfo } from "node:net";

const server = createServer((req, res) => {
  res.setHeader("x-a", "1");
  res.appendHeader("x-a", "2");
  res.setHeader("x-b", "b");
  console.log("names", res.getHeaderNames().join(","), res.hasHeader("x-a"), res.hasHeader("x-z"));
  const single = res.getHeader("x-b");
  console.log("headers", JSON.stringify(res.getHeaders()), typeof single === "string" ? single : typeof single);
  res.removeHeader("x-b");
  console.log("after remove", res.getHeaderNames().join(","), res.writableFinished);
  res.on("finish", () => console.log("finish", res.writableFinished, typeof res.socket?.remotePort));
  res.end("ok:" + req.method + req.url);
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as AddressInfo).port;
  const req = request({ port, host: "127.0.0.1", path: "/p", method: "POST" }, (res) => {
    let body = "";
    res.on("data", (chunk) => (body += chunk));
    res.on("end", () => {
      console.log(res.statusCode, body, res.headers["x-a"], res.headers["x-b"]);
      server.close();
    });
  });
  req.on("finish", () => console.log("request finish"));
  req.end("x");
});

const agent = new Agent({ keepAlive: true, maxSockets: 4 });
console.log(agent.maxSockets, typeof globalAgent.maxSockets);
agent.destroy();
const secure = new HttpsAgent({ keepAlive: true, maxSockets: 2 });
console.log(secure.maxSockets, typeof httpsGlobalAgent.maxSockets);
secure.destroy();
