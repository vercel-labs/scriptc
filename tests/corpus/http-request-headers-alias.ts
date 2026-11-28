// A per-name write after assigning a typed headers object mutates that object
// itself: an alias of the assigned value observes the write, as Node's
// req.headers accessor does.
import * as http from "node:http";

const server = http.createServer((req, res) => {
  const headers: { [name: string]: string | undefined } = { host: "h" };
  req.headers = headers;
  req.headers["x-forwarded-for"] = "1.2.3.4";
  console.log(headers["x-forwarded-for"], req.headers["x-forwarded-for"]);
  res.end("ok");
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  http.get({ host: "127.0.0.1", port, path: "/" }, (res) => {
    res.resume();
    res.on("end", () => {
      server.close();
    });
  });
});
