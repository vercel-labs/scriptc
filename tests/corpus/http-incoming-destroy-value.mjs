// IncomingMessage's destroy is a method value of the class — one function per
// class, the same on every read — and destroying an unread request reports
// Node's abort: 'aborted', then 'close' with both flags set.
import http from "node:http";

await new Promise((resolve) => {
  const server = http.createServer((request, response) => {
    console.log("type", typeof request.destroy);
    console.log("same", request.destroy === request.destroy);
    request.on("aborted", () => console.log("aborted"));
    request.on("close", () => {
      console.log("close", request.destroyed, request.aborted);
      response.destroy();
      server.close(() => resolve(undefined));
    });
    request.destroy();
  });
  server.listen(0, "127.0.0.1", () => {
    const client = http.request(
      { host: "127.0.0.1", port: server.address().port, path: "/", method: "POST" },
      (answer) => answer.resume(),
    );
    client.on("error", () => {});
    client.write("partial");
  });
});
