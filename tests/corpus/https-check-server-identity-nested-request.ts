// Building one https.request while another request's options evaluate
// leaves each request its own options.checkServerIdentity and
// options.servername: the inner request carries neither, so the outer
// request's check must not run for its connection (and its servername
// must not become the inner request's TLS name), and the outer request's
// connection must still fail with the answer the outer check returns.
// The check's first argument is the outer request's own TLS name. The
// outcomes print in a fixed order once both requests settle, so the
// program's output does not depend on which handshake finishes first.
import * as https from "node:https";
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const d = "tests/fixtures/server/certs";
const cert = readFileSync(`${d}/localhost.pem`);
const key = readFileSync(`${d}/localhost-key.pem`);
const ca = readFileSync(`${d}/ca.pem`);

const seen: string[] = [];
const server = https.createServer({ cert, key }, (req, res) => {
  seen.push(req.url ?? "");
  res.end("ok");
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  let check = "check did not run";
  let outer = "outer did not settle";
  let inner = "inner did not settle";
  let pending = 2;

  const done = (): void => {
    if (--pending > 0) return;
    for (const url of seen) console.log("server", url);
    console.log(check);
    console.log(outer);
    console.log(inner);
    server.close(() => console.log("closed"));
  };

  // The outer request's headers evaluate this function, which builds a
  // second request with no identity check and no servername of its own.
  const headersDuringOptions = (): Record<string, string> => {
    const innerReq = https.request({ hostname: "127.0.0.1", port, path: "/inner", ca }, (res) => {
      res.resume();
      res.on("end", () => {
        inner = `inner ${res.statusCode}`;
        done();
      });
    });
    innerReq.on("error", (e: Error & { code?: string }) => {
      inner = `inner error ${e.code}`;
      done();
    });
    innerReq.end();
    return { "x-outer": "1" };
  };

  const outerReq = https.request(
    {
      hostname: "127.0.0.1",
      port,
      path: "/outer",
      ca,
      servername: "outer.example",
      headers: headersDuringOptions(),
      checkServerIdentity: (host: string, _peer: tls.PeerCertificate) => {
        check = `outer check ran ${host}`;
        return new Error("rejected by the outer check");
      },
    },
    (res) => {
      res.resume();
      res.on("end", () => {
        outer = `outer ${res.statusCode}`;
        done();
      });
    },
  );
  outerReq.on("error", (e: Error) => {
    outer = `outer error ${e.message}`;
    done();
  });
  outerReq.end();
});
