// A URL's credentials are decoded per request and released: repeating the
// request must not accumulate the decoder's strings (the sanitized lane's
// reference audit counts them).
import * as http from "node:http";

const COUNT = 24;

const server = http.createServer((req, res) => {
  res.end(String(req.headers.authorization === "Basic dXNlcjpwYXNz"));
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  let done = 0;
  const next = (): void => {
    if (done === COUNT) {
      console.log("requests", COUNT);
      console.log("all authorized", authorized === COUNT);
      server.close();
      return;
    }
    done += 1;
    http.get(`http://user:pass@127.0.0.1:${port}/`, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { body += chunk; });
      res.on("end", () => {
        if (body === "true") authorized += 1;
        next();
      });
    }).on("error", (e) => { console.log("error", e.message); next(); });
  };
  let authorized = 0;
  next();
});
