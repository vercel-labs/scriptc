// OutgoingMessage.pipe() through an untyped value: the runtime's member
// dispatch answers what the typed call answers. A response takes no 'error'
// listener, so the emit is the throw at the call; a request without one
// throws the same error rather than ending the process, and a listener gets
// it instead.
import http from "node:http";

/**
 * @param {any} message
 * @param {any} destination
 */
const pipeValue = (message, destination) => message.pipe(destination);

const server = http.createServer((request, response) => {
  try {
    pipeValue(response);
    console.log("response pipe accepted");
  } catch (err) {
    console.log("response pipe", err.code, err.message);
  }
  response.end("ok");
});

const withListener = (port) => {
  const request = http.request({ host: "127.0.0.1", port, path: "/" }, (res) => {
    res.resume();
    res.on("end", () => {
      console.log("second", res.statusCode);
      withoutListener(port);
    });
  });
  request.on("error", (err) => console.log("client pipe", err.code, err.message));
  pipeValue(request, { write: () => true });
  request.end();
};

const withoutListener = (port) => {
  const request = http.request({ host: "127.0.0.1", port, path: "/" }, (res) => {
    res.resume();
    res.on("end", () => {
      console.log("third", res.statusCode);
      server.close();
    });
  });
  try {
    pipeValue(request);
    console.log("unlistened pipe accepted");
  } catch (err) {
    console.log("unlistened pipe", err.code, err.message);
  }
  request.end();
};

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  const first = http.request({ host: "127.0.0.1", port, path: "/" }, (res) => {
    res.resume();
    res.on("end", () => {
      console.log("first", res.statusCode);
      withListener(port);
    });
  });
  first.end();
});
