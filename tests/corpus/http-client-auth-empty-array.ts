// An explicit empty Authorization array is an override: Node's getHeader
// answers the array (truthy), so a URL's credentials are not turned into a
// header, and nothing is sent.
import * as http from "node:http";

const server = http.createServer((req, res) => {
  console.log("authorization", JSON.stringify(req.headers.authorization));
  res.end("ok");
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const options: http.RequestOptions = { headers: { authorization: [] } };
  http.get(`http://user:pass@127.0.0.1:${port}/`, options, (res) => {
    res.resume();
    res.on("end", () => {
      console.log("status", res.statusCode);
      server.close();
    });
  }).on("error", (e) => console.log("error", e.message));
});
