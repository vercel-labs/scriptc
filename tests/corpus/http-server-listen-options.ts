// server.listen() with the options object: Node reads { port, host, path },
// takes the port branch when it has a port (so the port wins over a path
// key), binds a non-numeric string path as a UNIX socket, and throws
// ERR_INVALID_ARG_VALUE for an object it cannot read and ERR_SOCKET_BAD_PORT
// for a port outside 0..65535. The https server takes the same form.
// Messages print relative to the temporary directory so the output does not
// depend on it.
import * as http from "node:http";
import * as https from "node:https";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriptc-listen-options-"));
const sock = path.join(dir, "http.sock");
const ignored = path.join(dir, "ignored.sock");
const tlsSock = path.join(dir, "https.sock");
const shown = (text: string): string => text.split(dir).join("<dir>");

function catchListen(label: string, start: (server: http.Server) => void): void {
  const server = http.createServer((_req: http.IncomingMessage, res: http.ServerResponse) =>
    res.end("x"),
  );
  try {
    start(server);
    console.log(label, "no throw");
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    console.log(label, error.name, error.code, shown(error.message ?? ""));
  }
}

function get(socketPath: string, route: string, next: () => void): void {
  http.get({ socketPath, path: route }, (res: http.IncomingMessage) => {
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => console.log("response", chunk));
    res.on("end", next);
  });
}

function unixWithHost(): void {
  const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
    res.end(`unix ${req.url} host=${req.headers.host}`);
  });
  server.listen({ path: sock, host: "127.0.0.1" }, () => {
    console.log("unix listening", server.listening, fs.existsSync(sock));
    get(sock, "/via-path", () => {
      server.close(() => {
        console.log("unix closed", fs.existsSync(sock));
        portWins();
      });
    });
  });
}

function portWins(): void {
  const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
    res.end(`tcp ${req.url}`);
  });
  server.listen({ port: 0, host: "127.0.0.1", path: ignored }, () => {
    const address = server.address();
    if (address === null || typeof address === "string") return;
    console.log("tcp listening", address.address, address.port > 0, fs.existsSync(ignored));
    const client = http.get(
      { host: "127.0.0.1", port: address.port, path: "/via-port" },
      (res: http.IncomingMessage) => {
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => console.log("response", chunk));
        res.on("end", () => server.close(() => undefinedPort()));
      },
    );
    client.on("error", (error: Error) => console.log("client error", error.message));
  });
}

function undefinedPort(): void {
  const server = http.createServer((_req: http.IncomingMessage, res: http.ServerResponse) =>
    res.end("undefined"),
  );
  server.listen({ path: sock, port: undefined }, () => {
    const address = server.address();
    if (address === null || typeof address === "string") return;
    console.log("undefined port", address.port > 0, fs.existsSync(sock));
    server.close(() => errors());
  });
}

function errors(): void {
  catchListen("empty path", (server) => server.listen({ path: "" }));
  catchListen("no keys", (server) => server.listen({}));
  catchListen("host only", (server) => server.listen({ host: "127.0.0.1" }));
  catchListen("undefined path", (server) => server.listen({ path: undefined }));
  catchListen("big port", (server) => server.listen({ port: 70000 }));
  catchListen("negative port", (server) => server.listen({ port: -1 }));
  catchListen("fractional port", (server) => server.listen({ port: 1.5 }));
  tls();
}

function tls(): void {
  const cert = fs.readFileSync("tests/fixtures/server/certs/localhost.pem", "utf8");
  const key = fs.readFileSync("tests/fixtures/server/certs/localhost-key.pem", "utf8");
  const server = https.createServer(
    { cert, key },
    (req: http.IncomingMessage, res: http.ServerResponse) => {
      res.end(`tls ${req.url}`);
    },
  );
  server.listen({ path: tlsSock }, () => {
    console.log("tls listening", server.listening, fs.existsSync(tlsSock));
    const req = https.request(
      { socketPath: tlsSock, path: "/via-tls", rejectUnauthorized: false },
      (res: http.IncomingMessage) => {
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => console.log("response", chunk));
        res.on("end", () => {
          server.close(() => {
            console.log("tls closed", fs.existsSync(tlsSock));
            fs.rmSync(dir, { recursive: true, force: true });
            console.log("done");
          });
        });
      },
    );
    req.on("error", (error: Error) => console.log("tls error", error.message));
    req.end();
  });
}

unixWithHost();
