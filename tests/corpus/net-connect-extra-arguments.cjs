// socket.connect(path, ...): Node evaluates every argument expression; with
// three arguments the LAST is the callback slot (the middle is evaluated
// and ignored), and with two a non-function second argument is evaluated
// and ignored — the dial still proceeds. The program pins both shapes, so
// an argument expression is never silently dropped.
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const sockPath = path.join(os.tmpdir(), `scr-connect-args-${process.pid}.sock`);
const server = net.createServer((socket) => socket.on("data", () => {}));
server.listen(sockPath, () => {
  const sideEffect = () => {
    console.log("middle-ran");
    return () => console.log("third-callback-ran");
  };
  const first = new net.Socket();
  first.on("error", (err) => console.log("first-error", err.code));
  first.connect(sockPath, () => console.log("second-ran"), sideEffect());

  setTimeout(() => {
    first.destroy();
    const second = new net.Socket();
    second.on("error", (err) => console.log("second-error", err.code));
    second.connect(sockPath, "not a listener");
    setTimeout(() => {
      second.destroy();
      server.close(() => {
        try {
          fs.unlinkSync(sockPath);
        } catch {}
        console.log("closed");
      });
    }, 200);
  }, 200);
});
