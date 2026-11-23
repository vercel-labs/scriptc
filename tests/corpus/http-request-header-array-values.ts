// A request header value that is a string array is written as one line per
// element, in source order, as Node writes it: the options record and
// setHeader agree on the wire shape.
import * as http from "node:http";
import * as net from "node:net";

const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
  // the Host header carries the random port: log the caller's own lines
  const seen: string[] = [];
  const raw = req.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i] ?? "";
    if (name.toLowerCase().startsWith("x-")) seen.push(name + "=" + (raw[i + 1] ?? ""));
  }
  console.log(req.url, seen.join(","));
  res.end("ok");
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as net.AddressInfo).port;
  const multi: string[] = ["c", "d"];
  const first = http.request(
    {
      host: "127.0.0.1",
      port,
      path: "/literal",
      headers: {
        "x-one": "1",
        "x-multi": ["a", "b"],
        "x-two": "2",
        "x-count": 3,
      },
    },
    (res: http.IncomingMessage) => {
      res.resume();
      res.on("end", () => {
        const second = http.request(
          { host: "127.0.0.1", port, path: "/dynamic", headers: { "x-dyn": multi } },
          (res2: http.IncomingMessage) => {
            res2.resume();
            res2.on("end", () => {
              const third = http.request({ host: "127.0.0.1", port, path: "/setheader" }, (res3: http.IncomingMessage) => {
                res3.resume();
                res3.on("end", () => {
                  console.log("done");
                  server.close();
                });
              });
              third.setHeader("x-set", ["e", "f"]);
              third.end();
            });
          },
        );
        second.end();
      });
    },
  );
  first.end();
});
