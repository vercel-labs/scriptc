/* The PURE client differential: this program is only a CLIENT, and the
 * per-case driver is the SERVER (the inverse of every other case). Port
 * protocol, inverted: bind an ephemeral port to LEARN a free number,
 * release it, print PORT — the harness hands it to driver.mjs, which
 * binds that exact port with a real Node http server. The client retries
 * silently on ECONNREFUSED until the driver is up (both lanes race the
 * same way; retries print nothing), then runs the scripted exchanges:
 * a GET over Content-Length framing, a CHUNKED streaming response, a
 * a 205 response whose invalid-but-observable body Node still delivers,
 * a HEAD (no body regardless of Content-Length), and /quit to stop the
 * driver. Exercises the runtime parser against Node's real serializer. */
import { createServer } from "node:net";
import { request } from "node:http";

let port = 0;
let attempts = 0;

function fetchPath(path: string, method: string, next: () => void): void {
  const req = request({ hostname: "127.0.0.1", port, path, method }, (res) => {
    const sc = res.statusCode;
    const te = res.headers["transfer-encoding"];
    const cl = res.headers["content-length"];
    console.log(
      `${method} ${path} status=${sc !== undefined ? sc : -1} te=${te !== undefined ? te : "-"} cl=${cl !== undefined ? cl : "-"}`,
    );
    let body = "";
    res.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    res.on("end", () => {
      console.log(`${method} ${path} body=${body}`);
      next();
    });
  });
  req.on("error", (err) => console.log(`${method} ${path} error ${err.message}`));
  req.end();
}

function start(): void {
  attempts++;
  const req = request({ hostname: "127.0.0.1", port, path: "/ready", method: "GET" }, (res) => {
    res.on("end", () => {
      console.log("driver up");
      fetchPath("/text", "GET", () => {
        fetchPath("/chunked", "GET", () => {
          fetchPath("/reset-content", "GET", () => {
            fetchPath("/text", "HEAD", () => {
              fetchPath("/quit", "GET", () => console.log("done"));
            });
          });
        });
      });
    });
    res.on("data", () => {});
  });
  req.on("error", () => {
    if (attempts < 400) {
      setTimeout(start, 25);
    } else {
      console.log("driver never came up");
    }
  });
  req.end();
}

const probe = createServer();
probe.listen(0, () => {
  port = probe.address().port;
  probe.close(() => {
    process.stderr.write(`PORT ${port}\n`);
    start();
  });
});
