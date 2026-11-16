// The informational responses reached through an untyped message: the
// response crosses into JavaScript as a plain value, so each call goes
// through the runtime's member dispatch rather than the typed lowering. The
// header checks and the callback each form takes are Node's there too.
import http from "node:http";

/**
 * @param {any} response
 */
const callContinue = (response, callback) => response.writeContinue(callback);

/**
 * @param {any} response
 */
const callProcessing = (response) => response.writeProcessing();

/**
 * @param {any} response
 * @param {any} hints
 */
const callEarlyHints = (response, hints, callback) => response.writeEarlyHints(hints, callback);

/**
 * @param {any} response
 * @param {any} status
 * @param {any} headers
 */
const callInformation = (response, status, headers, callback) =>
  response.writeInformation(status, headers, callback);

const server = http.createServer((request, response) => {
  if (request.url === "/continue") {
    callContinue(response, () => console.log("continue callback"));
    console.log("continue sent", response.headersSent);
  } else if (request.url === "/processing") {
    callProcessing(response);
  } else if (request.url === "/early") {
    callEarlyHints(response, { link: "</style.css>; rel=preload; as=style" }, () => {
      console.log("early hints callback");
    });
  } else if (request.url === "/info") {
    const accepted = callInformation(response, 102, { "x-i": "1" }, () => {
      console.log("information callback");
    });
    console.log("info", accepted);
  } else if (request.url === "/array") {
    // an array value is one line, its elements joined by commas
    callInformation(response, 103, { "x-multi": ["a", "b"] });
  } else if (request.url === "/undefined") {
    try {
      callInformation(response, 103, { "x-u": undefined });
      console.log("undefined accepted");
    } catch (err) {
      console.log("undefined", err.code, err.message);
    }
  }
  response.end("ok");
});

const paths = ["/continue", "/processing", "/early", "/info", "/array", "/undefined"];
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
    console.log(
      pathAt(i),
      "information",
      info.statusCode,
      info.statusMessage,
      info.headers["link"],
      info.headers["x-i"],
      info.headers["x-multi"],
    );
  });
  request.on("error", (err) => {
    console.log(pathAt(i), "error", err.code);
    next(i + 1);
  });
  request.end();
};

server.listen(0, "127.0.0.1", () => next(0));
