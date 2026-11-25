// listen() converts options.backlog with ToNumber while the call runs, and a
// valueOf hook may remove sibling options from the bag. Node has read port,
// host and path before that conversion, so the removed properties still
// decide the bind: the host stays 127.0.0.1, the port binds, and the pipe
// path binds.
const net = require("node:net");

function listenWith(label, options, pipe, next) {
  const server = net.createServer();
  server.on("error", (e) => {
    console.log(label, "error", e.code);
    next();
  });
  try {
    server.listen(options, () => {
      if (pipe) {
        console.log(label, "listening", "pipe");
      } else {
        const address = server.address();
        console.log(label, "listening", address.family, address.address, address.port > 0);
      }
      server.close();
      next();
    });
  } catch (e) {
    console.log(label, "threw", e.code, JSON.stringify(e.message));
    next();
  }
}

const hostOptions = {
  host: "127.0.0.1",
  port: 0,
  backlog: {
    valueOf() {
      delete hostOptions.host;
      return 511;
    },
  },
};

const portOptions = {
  port: 0,
  host: "127.0.0.1",
  backlog: {
    valueOf() {
      delete portOptions.port;
      return 511;
    },
  },
};

const pathOptions = {
  path: "/tmp/scriptc-backlog-coercion-" + process.pid + ".sock",
  backlog: {
    valueOf() {
      delete pathOptions.path;
      return 511;
    },
  },
};

listenWith("host", hostOptions, false, () => {
  listenWith("port", portOptions, false, () => {
    listenWith("path", pathOptions, true, () => console.log("done"));
  });
});
