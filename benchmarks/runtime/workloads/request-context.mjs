// An HTTP server whose adapter builds a Fetch Request for every request and
// adds an own property to it (`req.context = {}`), the shape a bundled web
// framework's adapter has. The write happens at the end of the middleware
// chain the adapter dispatches through, and only the adapter's outermost
// layer catches: a build that refuses the write unwinds the whole chain
// before the adapter's fallback runs. Both builds answer the same responses,
// so the samples time the request/response path with the property write in it.
import { createServer } from "node:http";

let requests = 0;
// Written by the adapter and the middleware layers' cleanup, so their work
// stays live in both builds.
let lastRequest = null;
let layersLeft = 0;

// The middleware chain a framework dispatches a request through.
const LAYERS = 40;

function attachContext(req) {
  const id = req.headers["x-request-id"] ?? "";
  const request = new Request("http://bench.local" + (req.url ?? "/"), {
    method: req.method ?? "GET",
  });
  // Kept before the write so the handle stays live in a build that refuses
  // the property and unwinds from here.
  lastRequest = request;
  request.context = { id };
}

function dispatch(req, res, layer) {
  if (layer === 0) {
    attachContext(req);
    return;
  }
  try {
    dispatch(req, res, layer - 1);
  } finally {
    layersLeft += layer;
  }
}

function respond(req, res) {
  const id = req.headers["x-request-id"] ?? "";
  res.statusCode = 200;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-request-id", id);
  res.end("ok " + id);
}

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    requests++;
    if (req.method === "POST" && req.url === "/shutdown") {
      res.statusCode = 200;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.end("bye");
      server.close(() => {
        console.log(
          "requests " + requests + " layers " + layersLeft +
            " request " + (lastRequest ? "yes" : "no"),
        );
      });
      return;
    }
    try {
      dispatch(req, res, LAYERS);
    } catch {
      // No own properties on fetch handles: the adapter's fallback path.
    }
    respond(req, res);
  });
});

server.listen(0, "127.0.0.1", () => {
  process.stderr.write("PORT " + server.address().port + "\n");
});
