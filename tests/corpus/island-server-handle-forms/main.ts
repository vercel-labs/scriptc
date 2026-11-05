// @requires-libnode
// The island's servers reached in the forms a plain top-level binding does
// not cover: a factory result whose member is called in place, a
// function-local `var`, and a binding a function declared above it captures
// before its declaration. Each value is the island's own server — the
// listening socket lives in the island — so address(), listening and
// close() dispatch through the handle, as they do for the plain binding.
import { httpServer } from "server-pkg";

// No binding names the factory's result; address() is read in place.
console.log("direct", httpServer((_req, res) => res.end("ok")).address());

function varPhase(next: () => void): void {
  var server = httpServer((_req, res) => res.end("ok"));
  console.log("var before", server.listening, server.address());
  server.on("listening", () => {
    console.log("var listening event", server.listening);
  });
  server.listen(0, () => {
    const addr = server.address();
    console.log("var listening", server.listening, typeof addr === "object" && addr !== null);
    server.close(() => {
      console.log("var closed", server.listening);
      next();
    });
  });
}

function forwardPhase(next: () => void): void {
  // Declared before the binding it reads, the way a cleanup handler is.
  const announce = (): void => {
    console.log("forward", server.listening, server.address() === null);
  };
  const server = httpServer((_req, res) => res.end("ok"));
  announce();
  server.listen(0, () => {
    const addr = server.address();
    console.log("forward listening", server.listening, typeof addr === "object" && addr !== null);
    server.close(() => {
      console.log("forward closed", server.listening);
      next();
    });
  });
}

varPhase(() => forwardPhase(() => {}));
