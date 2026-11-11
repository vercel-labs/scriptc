// A response driven by its own backpressure: each round corks and writes
// two 40 KB chunks, so write() answers false and writableNeedDrain turns on;
// the 'drain' listener re-corks the next round, and the last round ends the
// response. The lengths show the buffer empties before 'drain' runs, and the
// client counts every byte.
import * as http from "node:http";

const server = http.createServer((_req: http.IncomingMessage, res: http.ServerResponse) => {
  const chunk = "x".repeat(40000);
  console.log("fresh", res.writableHighWaterMark, res.writableLength, res.writableNeedDrain);
  let cycle = 0;
  const round = (): void => {
    cycle++;
    const current = cycle;
    res.cork();
    const first = res.write(chunk);
    const second = res.write(chunk);
    console.log("cycle", current, first, second, res.writableLength, res.writableNeedDrain);
    res.once("drain", () => {
      console.log("drain", current, res.writableLength, res.writableNeedDrain);
      if (current < 3) round();
      else res.end();
    });
    res.uncork();
  };
  round();
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address === null || typeof address === "string") return;
  http.get({ host: "127.0.0.1", port: address.port, path: "/" }, (res: http.IncomingMessage) => {
    let length = 0;
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      length += chunk.length;
    });
    res.on("end", () => {
      console.log("client", length);
      server.close(() => console.log("closed"));
    });
  });
});
