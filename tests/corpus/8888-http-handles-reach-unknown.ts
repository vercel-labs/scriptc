// A typed HTTP server whose handles reach untyped code late: the request
// listener is typed, and it hands its request and response to a function
// that takes `unknown`; a second listener goes on the server through an
// `any` binding. The handles' dynamic members answer there, and the
// dynamic 'request' listener runs with dynamic handles of its own.
import * as http from "node:http";
import * as net from "node:net";

function answer(request: unknown, response: unknown): void {
  const req = request as any;
  const res = response as any;
  const facts = [req.method, req.url, typeof req.headers, req.headers.host, req.httpVersion];
  res.setHeader("x-facts", facts.join(","));
  res.statusCode = 201;
  res.end(`untyped ${req.url}`);
}

const log: string[] = [];

const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
  log.push(`typed ${req.method} ${req.url}`);
  answer(req, res);
});

const untypedServer: any = server;
untypedServer.on("request", (req: any, res: any) => {
  log.push(`dynamic listener ${req.url} ${res.statusCode} ${req.socket === res.socket}`);
});

function get(port: number, path: string, done: () => void): void {
  const socket = net.connect(port, "127.0.0.1", () =>
    socket.write(`GET ${path} HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n`),
  );
  let reply = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    reply += chunk;
  });
  socket.on("close", () => {
    const lines = reply.split("\r\n");
    log.push(`${lines[0]} ${lines.find((line) => line.startsWith("x-facts")) ?? ""}`);
    log.push(JSON.stringify(reply.slice(reply.indexOf("\r\n\r\n") + 4)));
    done();
  });
}

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as net.AddressInfo).port;
  get(port, "/a", () =>
    get(port, "/b", () =>
      server.close(() => {
        for (const line of log) console.log(line);
      }),
    ),
  );
});
