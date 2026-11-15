// server.listen({ handle: boundSocket }) registers its callback before the
// handle is selected (Node calls once('listening', cb) first), so a
// 'newListener' hook can remove the bag's handle before adoption reads it.
// The listen then falls through the options ladder, which reports a bag with
// neither port nor path; the same holds when the server crosses as a dynamic
// value and dispatches through the handle.
const net = require("node:net");

function attempt(label, run) {
  try {
    const value = run();
    console.log(label, "returned", typeof value);
  } catch (e) {
    console.log(label, e.code, JSON.stringify(e.message));
  }
}

// An inline handle: the options bag is its only owner.
const viaOptions = net.createServer();
const options = { handle: new net.BoundSocket({ port: 0 }) };
viaOptions.on("newListener", (ev) => {
  if (ev === "listening") delete options.handle;
});
attempt("dynamic arguments", () => viaOptions.listen(options, () => console.log("listening")));

// The same bag reaches the server's dynamic handle dispatch when the server
// is passed through an untyped function.
function through(srv, opts) {
  try {
    srv.listen(opts, () => console.log("dynamic listening"));
  } catch (e) {
    console.log("handle dispatch", e.code, JSON.stringify(e.message));
  }
}
const dynamicServer = net.createServer();
const dynamicOptions = { handle: new net.BoundSocket({ port: 0 }) };
dynamicServer.on("newListener", (ev) => {
  if (ev === "listening") delete dynamicOptions.handle;
});
through(dynamicServer, dynamicOptions);
console.log("done");
