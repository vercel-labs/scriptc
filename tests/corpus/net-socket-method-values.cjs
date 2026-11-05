// A socket read through an untyped binding answers its methods as
// functions: typeof reports "function", every socket answers the same
// function for a name, as Node's prototype methods are, and calling the
// function with a socket as `this` runs the method on that socket.
"use strict";
const net = require("net");

const names = ["write", "end", "setKeepAlive", "setNoDelay", "setTimeout", "setEncoding", "pause", "resume", "destroy", "on", "once", "address", "ref", "unref"];
let first;
const server = net.createServer((socket) => {
  console.log(names.map((name) => `${name}:${typeof socket[name]}`).join(" "));
  console.log("missing:", typeof socket.notAMethod);
  if (first === undefined) {
    first = socket;
    return;
  }
  console.log("same function:", names.every((name) => socket[name] === first[name]));
  const write = socket.write;
  write.call(socket, "via call\n");
  socket.end.call(socket);
  first.end();
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  let open = 2;
  const texts = [];
  for (let i = 0; i < 2; i++) {
    const client = net.connect(port, "127.0.0.1");
    let text = "";
    client.setEncoding("utf8");
    client.on("data", (chunk) => (text += chunk));
    client.on("end", () => {
      texts.push(JSON.stringify(text));
      if (--open === 0) {
        console.log("clients:", texts.sort().join(" "));
        server.close();
      }
    });
  }
});
