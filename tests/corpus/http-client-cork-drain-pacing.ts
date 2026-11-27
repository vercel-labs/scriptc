import * as http from "node:http";

const server = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => res.end("ok"));
});

server.listen(0, "127.0.0.1", () => {
  const request = http.request(
    { port: (server.address() as { port: number }).port, host: "127.0.0.1", method: "POST" },
    (response) => {
      response.resume();
      response.on("end", () => server.close());
    },
  );
  request.on("error", () => {});
  request.on("drain", () => console.log("drain"));
  request.on("socket", () => {
    request.write("x");
    setTimeout(() => {
      request.cork();
      console.log("write", request.write("a".repeat(128 * 1024)));
      setTimeout(() => {
        console.log("before uncork");
        request.uncork();
        setTimeout(() => request.end(), 100);
      }, 100);
    }, 100);
  });
});
