// http.request's `signal` option: aborting destroys the request with an
// AbortError (code ABORT_ERR, the signal's reason as `cause`), including a
// signal that is already aborted, and an abort after the response has no
// effect. req.destroy(err) reports err as the request's 'error'. A value
// that is not an AbortSignal throws from http.request before any request
// is made.
import * as http from "node:http";

const server = http.createServer((req, res) => {
  setTimeout(() => res.end("late"), 300);
});

function attempt(label: string, start: (done: () => void) => void): Promise<void> {
  return new Promise<void>((resolve) => start(() => setTimeout(resolve, 20)));
}

server.listen(0, "127.0.0.1", async () => {
  const port = (server.address() as { port: number }).port;
  await attempt("abort later", (done) => {
    const controller = new AbortController();
    const req = http.request({ host: "127.0.0.1", port, path: "/", signal: controller.signal });
    req.on("error", (err: Error) => console.log("error", err.name, (err as NodeJS.ErrnoException).code, err.message));
    req.on("close", () => {
      console.log("close", req.destroyed);
      done();
    });
    req.end();
    setTimeout(() => controller.abort(), 30);
  });
  await attempt("already aborted", (done) => {
    const controller = new AbortController();
    controller.abort();
    const req = http.request({ host: "127.0.0.1", port, path: "/", signal: controller.signal });
    req.on("error", (err: Error) => console.log("error", err.name, (err as NodeJS.ErrnoException).code, err.message));
    req.on("close", () => {
      console.log("close", req.destroyed);
      done();
    });
    req.end();
  });
  await attempt("reason", (done) => {
    const controller = new AbortController();
    const req = http.request({ host: "127.0.0.1", port, path: "/", signal: controller.signal });
    req.on("error", (err: Error) => console.log("error", err.name, String(err.cause)));
    req.on("close", () => done());
    req.end();
    setTimeout(() => controller.abort("stop"), 30);
  });
  await attempt("destroy with error", (done) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/" });
    req.on("error", (err: Error) => console.log("error", err.name, err.message));
    req.on("close", () => {
      console.log("close", req.destroyed);
      done();
    });
    req.end();
    setTimeout(() => req.destroy(new TypeError("custom failure")), 30);
  });
  await attempt("signal after response", (done) => {
    const controller = new AbortController();
    const fast = http.createServer((req, res) => res.end("fast"));
    fast.listen(0, "127.0.0.1", () => {
      const fastPort = (fast.address() as { port: number }).port;
      http.get({ host: "127.0.0.1", port: fastPort, path: "/", signal: controller.signal }, (res) => {
        res.resume();
        res.on("end", () => {
          controller.abort();
          console.log("aborted after end", controller.signal.aborted);
          fast.close();
          done();
        });
      });
    });
  });
  try {
    http.request({ host: "127.0.0.1", port, path: "/", signal: {} as AbortSignal });
    console.log("no throw");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log("not a signal", err.code, err.message);
  }
  server.close();
  server.closeAllConnections();
});
