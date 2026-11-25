// A request's `constructor` read before the program ever reads the HTTP class
// exports still answers the class value, so identity checks do not depend on
// evaluation order.
import http from "node:http";

await new Promise((resolve) => {
  const server = http.createServer((request, response) => {
    const constructor = request.constructor;
    console.log("constructor-first", constructor.name, constructor === http.IncomingMessage);
    const responseConstructor = response.constructor;
    console.log(
      "response-constructor-first",
      responseConstructor.name,
      responseConstructor === http.ServerResponse,
    );
    response.end("ok");
  });
  server.listen(0, "127.0.0.1", () => {
    const client = http.get({ host: "127.0.0.1", port: server.address().port, path: "/" }, (answer) => {
      answer.resume();
      answer.on("end", () => server.close(() => resolve(undefined)));
    });
    client.on("error", () => server.close(() => resolve(undefined)));
  });
});
