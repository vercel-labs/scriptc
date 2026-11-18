// res.writeInformation: the generic informational response (any 1xx but
// 101), the header lines it writes, its status and state checks, and the
// client's 'information' event.
import * as http from "node:http";

const server = http.createServer((req, res) => {
  const url = req.url;
  if (url === "/plain") {
    const accepted = res.writeInformation(102);
    console.log("plain", accepted, res.headersSent);
    res.end("ok");
    return;
  }
  if (url === "/headers") {
    const accepted = res.writeInformation(199, { "x-info": "v", "x-two": "2" });
    console.log("headers", accepted);
    res.end("done");
    return;
  }
  const check = (label: string, run: () => void): void => {
    try {
      run();
      console.log(label, "accepted");
    } catch (err) {
      const e = err as { code?: string; message?: string };
      console.log(label, e.code, e.message);
    }
  };
  if (url === "/range-low") {
    check("low", () => res.writeInformation(99));
    res.end();
    return;
  }
  if (url === "/range-high") {
    check("high", () => res.writeInformation(200));
    res.end();
    return;
  }
  if (url === "/fraction") {
    check("fraction", () => res.writeInformation(102.5));
    res.end();
    return;
  }
  if (url === "/switch") {
    check("switch", () => res.writeInformation(101));
    res.end();
    return;
  }
  if (url === "/sent") {
    res.write("x");
    check("sent", () => res.writeInformation(103));
    res.end();
    return;
  }
  if (url === "/badname") {
    check("badname", () => res.writeInformation(102, { "bad name": "1" }));
    res.end();
    return;
  }
  res.end("other");
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  const paths = [
    "/plain",
    "/headers",
    "/range-low",
    "/range-high",
    "/fraction",
    "/switch",
    "/sent",
    "/badname",
  ];
  const pathAt = (i: number): string => paths[i] ?? "/other";
  const run = (i: number): void => {
    if (i >= paths.length) {
      server.close();
      return;
    }
    const req = http.request({ host: "127.0.0.1", port, path: pathAt(i) }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
      res.on("end", () => {
        console.log(pathAt(i), res.statusCode, body);
        run(i + 1);
      });
    });
    req.on("information", (info) => {
      console.log(
        pathAt(i),
        "information",
        info.statusCode,
        info.statusMessage,
        String(info.headers["x-info"]),
        String(info.headers["x-two"]),
      );
    });
    req.on("error", (err) => {
      console.log(pathAt(i), "error", (err as { code?: string }).code);
      run(i + 1);
    });
    req.end();
  };
  run(0);
});
