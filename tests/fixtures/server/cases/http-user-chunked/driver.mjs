import { connect } from "node:net";

const port = Number(process.argv[2]);

function rawGet(path) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
    });
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("close", () => {
      const response = Buffer.concat(chunks).toString("utf8");
      resolve(response.slice(response.indexOf("\r\n\r\n") + 4));
    });
    socket.on("error", reject);
  });
}

console.log(JSON.stringify(await rawGet("/chunked")));
console.log(JSON.stringify(await rawGet("/extension")));
