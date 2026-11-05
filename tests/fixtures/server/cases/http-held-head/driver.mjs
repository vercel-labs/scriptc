// Raw-socket requests: for the delayed responses, prints whether any
// bytes arrived 150 ms after the request (the server answers after
// 300 ms), then the whole response with the Date value masked.
import { connect } from "node:net";

const port = Number(process.argv[2]);

function probe(path, delayed) {
  return new Promise((resolve, reject) => {
    const sock = connect(port, "127.0.0.1");
    let got = Buffer.alloc(0);
    let early = 0;
    sock.on("connect", () => {
      sock.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
      if (delayed) setTimeout(() => (early = got.length), 150);
    });
    sock.on("data", (c) => (got = Buffer.concat([got, c])));
    sock.on("end", () => {
      const text = got.toString("latin1").replace(/^Date: .*\r\n/m, "Date: -\r\n");
      if (delayed) console.log(`${path} early=${early > 0 ? "head" : "none"}`);
      console.log(JSON.stringify(text));
      resolve();
    });
    sock.on("error", reject);
  });
}

await probe("/hold", true);
await probe("/flush", true);
await probe("/expect", true);
await probe("/cork", true);
await probe("/cork-flush", true);
await probe("/cork-write", true);
await probe("/length", false);
await probe("/quit", false);
console.log("driver done");
