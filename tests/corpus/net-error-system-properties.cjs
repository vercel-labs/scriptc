// net 'error' events carry Node's system error properties: errno, code
// and syscall, and for listen and connect the address and port (a Unix
// socket's path, with port -1 for listen). A reset connection's read error
// carries errno, code and syscall only.
"use strict";
const net = require("net");

function describe(label, err, port) {
  const hide = (text) => (port === undefined ? text : text.replace(String(port), "<port>"));
  console.log(
    label,
    JSON.stringify({
      message: hide(err.message),
      code: err.code,
      errno: err.errno,
      syscall: err.syscall,
      address: err.address,
      port: port !== undefined && err.port === port ? "<port>" : err.port,
    }),
  );
}

const taken = net.createServer();
taken.listen(0, "127.0.0.1", () => {
  const port = taken.address().port;
  const second = net.createServer();
  second.on("error", (err) => {
    describe("listen in use", err, port);
    const unix = net.createServer();
    unix.on("error", (err2) => {
      describe("listen path", err2);
      const client = net.connect(1, "127.0.0.1");
      client.on("error", (err3) => {
        describe("connect refused", err3);
        const resetting = net.createServer((socket) => {
          socket.on("error", (err4) => {
            describe("read reset", err4);
            resetting.close();
            taken.close();
          });
        });
        resetting.listen(0, "127.0.0.1", () => {
          const victim = net.connect(resetting.address().port, "127.0.0.1", () => {
            setTimeout(() => victim.resetAndDestroy(), 20);
          });
        });
      });
    });
    unix.listen("/nonexistent-dir/sock");
  });
  second.listen(port, "127.0.0.1");
});
