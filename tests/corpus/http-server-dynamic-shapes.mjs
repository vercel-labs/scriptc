// The checked-dynamic lane for the server options and informational
// responses: undocumented option keys drop, non-number/non-boolean
// option values take Node's runtime validation, writeInformation sends
// arbitrary 1xx heads (object, tuple and flat header shapes, callback),
// tuple-array writeHead headers, and setHeaders refuses a plain object.
import { createServer } from "node:http";
import { connect } from "node:net";

// Untyped helpers hand writeHead an entry array and setHeaders a plain
// object, the shapes Node's runtime accepts and refuses respectively.
function applyWriteHead(response, headers) {
  response.writeHead(202, headers);
}

function applyHeaders(response, headers) {
  response.setHeaders(headers);
}

const ignored = createServer({ timeout: 500 });
console.log("timeout option", ignored.timeout);
ignored.close();

const unknown = createServer({ unknownOption: 1 });
console.log("unknown option", unknown.keepAliveTimeout, unknown.requestTimeout);
unknown.close();

function attemptOptions(label, run) {
  try {
    const server = run();
    console.log(label, "ok");
    server.close();
  } catch (error) {
    console.log(label, error.name, error.code, error.message);
  }
}

attemptOptions("string requestTimeout", () => createServer({ requestTimeout: "100" }));
attemptOptions("string interval", () => createServer({ connectionsCheckingInterval: "30" }));
attemptOptions("number reject", () => createServer({ rejectNonStandardBodyWrites: 1 }));
attemptOptions("fractional reject", () => createServer({ rejectNonStandardBodyWrites: 0.5 }));

const server = createServer((req, res) => {
  res.sendDate = false;
  const attempt = (label, fn) => {
    try {
      const value = fn();
      console.log(label, "ok", typeof value);
    } catch (error) {
      console.log(label, error.name, error.code, error.message);
    }
  };
  if (req.url === "/info") {
    const returned = res.writeInformation(110, { "X-A": "1", "X-B": ["2", "3"] }, () => {
      console.log("info callback");
    });
    console.log("info returned", returned);
    res.writeInformation(103, [["Link", "</a.css>; rel=preload"]]);
    res.writeInformation(102);
    res.writeHead(200, { "Content-Length": "2" });
    res.end("ok");
    return;
  }
  if (req.url === "/errors") {
    attempt("status 101", () => res.writeInformation(101));
    attempt("status 99", () => res.writeInformation(99));
    attempt("status 200", () => res.writeInformation(200));
    attempt("status 1.5", () => res.writeInformation(1.5));
    attempt("status missing", () => res.writeInformation());
    attempt("odd array", () => res.writeInformation(102, ["X-A", "1", "X-B"]));
    attempt("bad name", () => res.writeInformation(102, { "Bad Name": "v" }));
    attempt("bad value", () => res.writeInformation(102, { "X-A": "a\rb" }));
    res.writeHead(200, { "Content-Length": "2" });
    attempt("after head", () => res.writeInformation(102));
    res.end("ok");
    return;
  }
  if (req.url === "/tuple") {
    applyWriteHead(res, [["X-A", "1"], ["X-B", "2"]]);
    res.end("ok");
    return;
  }
  if (req.url === "/setheaders") {
    try {
      applyHeaders(res, { "X-A": "1" });
    } catch (error) {
      console.log("setHeaders object", error.name, error.code, error.message);
    }
    res.writeHead(200, { "Content-Length": "2" });
    res.end("ok");
    return;
  }
  res.end("other");
});

server.listen(0, () => {
  const port = server.address().port;
  const paths = ["/info", "/errors", "/tuple", "/setheaders"];
  const visit = (index) => {
    if (index === paths.length) {
      server.close(() => console.log("closed"));
      return;
    }
    const path = paths[index];
    const socket = connect(port, "127.0.0.1");
    let wire = "";
    socket.on("connect", () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
    });
    socket.on("data", (chunk) => {
      wire += chunk.toString("latin1");
    });
    socket.on("end", () => {
      const heads = wire.split("\r\n\r\n");
      for (let i = 0; i < heads.length - 1; i++) {
        const lines = heads[i].split("\r\n");
        console.log("head", JSON.stringify(lines));
      }
      console.log("body", JSON.stringify(heads[heads.length - 1]));
      visit(index + 1);
    });
  };
  visit(0);
});
