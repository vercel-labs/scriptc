// The informational responses reached through an untyped message: a response
// held as a plain JavaScript value calls writeContinue, writeProcessing,
// writeEarlyHints and writeInformation through the runtime's member
// dispatch, and the client's 'information' event reports each 1xx head.
import http from "node:http";

const server = http.createServer((request, response) => {
  if (request.url === "/continue") {
    response.writeContinue();
    console.log("continue sent", response.headersSent);
  } else if (request.url === "/processing") {
    response.writeProcessing();
  } else if (request.url === "/early") {
    response.writeEarlyHints({ link: "</style.css>; rel=preload; as=style" });
  } else if (request.url === "/info") {
    const accepted = response.writeInformation(102, { "x-i": "1" });
    console.log("info", accepted);
  }
  response.end("ok");
});

const paths = ["/continue", "/processing", "/early", "/info"];
const pathAt = (i) => paths[i] ?? "/other";
const next = (i) => {
  if (i >= paths.length) {
    server.close();
    return;
  }
  const request = http.request({ host: "127.0.0.1", port: server.address().port, path: pathAt(i) }, (res) => {
    console.log(pathAt(i), res.statusCode);
    res.resume();
    res.on("end", () => next(i + 1));
  });
  request.on("information", (info) => {
    console.log(pathAt(i), "information", info.statusCode, info.statusMessage, info.headers["link"], info.headers["x-i"]);
  });
  request.on("error", (err) => {
    console.log(pathAt(i), "error", err.code);
    next(i + 1);
  });
  request.end();
};

server.listen(0, "127.0.0.1", () => next(0));
