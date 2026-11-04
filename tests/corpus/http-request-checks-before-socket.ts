// http.request checks the path and the method before it opens a socket, as
// Node's ClientRequest constructor does: createConnection is not called and
// a socketPath server sees no connection when either check throws.
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

function attempt(label: string, fn: () => void): void {
  try {
    fn();
    console.log(label, "no throw");
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    console.log(label, e.name, e.code);
  }
}

let connections = 0;
const socketPath = path.join(os.tmpdir(), `scriptc-checks-${process.pid}.sock`);
const server = net.createServer((socket) => {
  connections++;
  socket.destroy();
});

server.listen(socketPath, () => {
  attempt("createConnection path", () => {
    http.request({
      path: "/a b",
      createConnection: () => {
        console.log("createConnection called");
        return net.connect(socketPath);
      },
    });
  });
  attempt("createConnection method", () => {
    http.request({
      path: "/",
      method: "BAD METHOD",
      createConnection: () => {
        console.log("createConnection called");
        return net.connect(socketPath);
      },
    });
  });
  attempt("socketPath path", () => {
    http.request({ socketPath, path: "/a\tb" });
  });
  attempt("socketPath agent false path", () => {
    http.request({ socketPath, path: "/a b", agent: false });
  });
  attempt("socketPath method", () => {
    http.request({ socketPath, path: "/", method: "A(B" });
  });
  setTimeout(() => {
    console.log("connections", connections);
    server.close(() => console.log("closed"));
  }, 200);
});
