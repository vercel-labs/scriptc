// An array-valued header whose elements are PRESENT undefined values (a holey
// array copied with toReversed, which reads every slot) writes "undefined" per
// element, as Node does — never a trap.
import * as http from "node:http";

const server = http.createServer((req, res) => {
  const seen: string[] = [];
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]!;
    if (name.toLowerCase().startsWith("x-")) seen.push(name + "=" + req.rawHeaders[i + 1]!);
  }
  console.log("server", seen.join(","));
  res.end("ok");
});
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const holey: string[] = ["a"];
  holey.length = 3;
  const copied = holey.toReversed() as string[];
  const request = http.request({ port, host: "127.0.0.1", headers: { "x-copied": copied } });
  request.setHeader("x-set-copied", copied);
  request.on("response", (res) => {
    res.resume();
    res.on("end", () => server.close());
  });
  request.end();
});
