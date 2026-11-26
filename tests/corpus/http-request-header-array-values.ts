// A request header value that is a string array is written as one line per
// element, in source order, as Node writes it: the options record and
// setHeader agree on the wire shape, a later setHeader replaces every line
// the name held, and a hole in the array is written as Node writes it
// ("undefined") instead of aborting the process.
import * as http from "node:http";
import * as net from "node:net";

const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
  // the Host header carries the random port: log the caller's own lines
  const seen: string[] = [];
  const raw = req.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i] ?? "";
    const lower = name.toLowerCase();
    if (lower.startsWith("x-") || lower === "cookie") seen.push(name + "=" + (raw[i + 1] ?? ""));
  }
  console.log(req.url, seen.join(","));
  res.end("ok");
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as net.AddressInfo).port;
  const multi: string[] = ["c", "d"];
  const cases: Array<(p: number) => http.ClientRequest> = [
    (p) =>
      http.request({
        host: "127.0.0.1",
        port: p,
        path: "/literal",
        headers: { "x-one": "1", "x-multi": ["a", "b"], "x-two": "2", "x-count": 3 },
      }),
    (p) => http.request({ host: "127.0.0.1", port: p, path: "/dynamic", headers: { "x-dyn": multi } }),
    (p) => {
      const req = http.request({ host: "127.0.0.1", port: p, path: "/setheader" });
      req.setHeader("x-set", ["e", "f"]);
      return req;
    },
    (p) => {
      // a set replaces every line the name held
      const req = http.request({
        host: "127.0.0.1",
        port: p,
        path: "/overwrite",
        headers: { "x-multi": ["old1", "old2"] },
      });
      req.setHeader("x-multi", "only");
      return req;
    },
    (p) => {
      // an array whose tail is holes
      const holey: string[] = ["a"];
      holey.length = 3;
      return http.request({ host: "127.0.0.1", port: p, path: "/holey", headers: { "x-holey": holey } });
    },
    (p) => {
      const live: string[] = ["a"];
      live.length = 3;
      const req = http.request({ host: "127.0.0.1", port: p, path: "/holey-set" });
      req.setHeader("x-holey-set", live);
      return req;
    },
    (p) => {
      // a later initializer mutates an earlier array value: the header is
      // written from the array as it stands after the whole record is built
      const shared: string[] = ["a"];
      const bump = (): string => {
        shared.push("late");
        return "1";
      };
      return http.request({
        host: "127.0.0.1",
        port: p,
        path: "/ordering",
        headers: { "x-shared": shared, "x-bump": bump() },
      });
    },
    (p) =>
      // Node joins a Cookie array into one line
      http.request({
        host: "127.0.0.1",
        port: p,
        path: "/cookie",
        headers: { cookie: ["a=1", "b=2"] },
      }),
    (p) => {
      // appendHeader keeps every value the option array wrote
      const req = http.request({
        host: "127.0.0.1",
        port: p,
        path: "/append",
        headers: { "x-append": ["a", "b"] },
      });
      req.appendHeader("x-append", "c");
      req.appendHeader("x-append", ["d", "e"]);
      return req;
    },
    (p) => {
      const req = http.request({
        host: "127.0.0.1",
        port: p,
        path: "/cookie-append",
        headers: { cookie: ["a=1", "b=2"] },
      });
      req.appendHeader("cookie", "c=3");
      return req;
    },
  ];
  const driver = (index: number): void => {
    if (index >= cases.length) {
      server.close();
      return;
    }
    let req: http.ClientRequest;
    try {
      req = cases[index]!(port);
    } catch (e) {
      console.log("throw", index, (e as NodeJS.ErrnoException).code);
      driver(index + 1);
      return;
    }
    req.on("response", (res: http.IncomingMessage) => {
      res.resume();
      res.on("end", () => driver(index + 1));
    });
    req.on("error", (e) => {
      console.log("error", index, (e as NodeJS.ErrnoException).code);
      driver(index + 1);
    });
    req.end();
  };
  driver(0);
});
