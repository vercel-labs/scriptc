// Http2ServerRequest.destroy([error]) is stream.Readable's destroy: the
// request reports 'close' (and the given error first), and the backing
// Http2Stream is left alone — Node does not reset it. An HTTP/1 server
// request's destroy aborts the message and tears its socket down instead;
// both forms report the provided error with its own payload.
import * as http from "node:http";
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const lines: string[] = [];
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

for (const mode of ["plain", "error"] as const) {
  await new Promise<void>((resolve) => {
    const server = http2.createServer();
    server.on("request", (req, res) => {
      req.on("error", (error) => lines.push(`h2 ${mode} req error ${error.message}`));
      req.on("aborted", () => lines.push(`h2 ${mode} req aborted`));
      req.on("close", () => lines.push(`h2 ${mode} req close`));
      if (mode === "plain") {
        req.destroy();
      } else {
        req.destroy(new Error("boom"));
      }
      res.end("ok");
    });
    server.listen(0, "127.0.0.1", () => {
      const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      const request = client.request({ ":path": "/" });
      request.on("response", () => lines.push(`h2 ${mode} client response`));
      request.on("close", () => lines.push(`h2 ${mode} client close`));
      request.resume();
      request.end();
      void delay(200).then(() => {
        client.close(() => {
          server.close(() => resolve());
        });
      });
    });
  });
}

for (const mode of ["plain", "error"] as const) {
  await new Promise<void>((resolve) => {
    const server = http.createServer((req, res) => {
      req.on("error", (error) => lines.push(`h1 ${mode} req error ${error.message}`));
      req.on("aborted", () => lines.push(`h1 ${mode} req aborted`));
      req.on("close", () => lines.push(`h1 ${mode} req close`));
      if (mode === "plain") {
        req.destroy();
      } else {
        req.destroy(new Error("boom"));
      }
      lines.push(`h1 ${mode} socket destroyed ${req.socket.destroyed}`);
      res.end("ok");
      setTimeout(() => {
        lines.push(`h1 ${mode} socket later ${req.socket.destroyed}`);
      }, 80);
    });
    server.listen(0, "127.0.0.1", () => {
      const request = http.request({
        host: "127.0.0.1",
        port: (server.address() as AddressInfo).port,
        path: "/",
      });
      request.on("response", () => lines.push(`h1 ${mode} client response`));
      request.on("error", () => lines.push(`h1 ${mode} client error`));
      request.on("close", () => lines.push(`h1 ${mode} client close`));
      request.end();
      void delay(200).then(() => {
        server.close(() => resolve());
      });
    });
  });
}

for (const line of lines.sort()) console.log(line);
