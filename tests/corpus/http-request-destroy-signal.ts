// IncomingMessage.signal on a server request: destroy() of a message that
// did not complete aborts the signal — synchronously for a signal read
// before the destroy, and on the first read after it — while a message
// read to 'end' keeps an un-aborted signal with the same object on every
// read.
import * as http from "node:http";

const server = http.createServer((request, response) => {
  const path = request.url;
  if (path === "/early") {
    const signal = request.signal;
    request.destroy();
    console.log("early", signal.aborted, request.aborted, request.destroyed);
    return;
  }
  if (path === "/late") {
    request.destroy();
    setTimeout(() => console.log("late", request.signal.aborted, request.aborted), 20);
    return;
  }
  const signal = request.signal;
  const again = request.signal;
  request.resume();
  request.on("end", () => {
    console.log("complete", again === signal, signal.aborted, request.complete);
    response.end("ok");
  });
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address() as { port: number };
  const paths = ["/early", "/late", "/complete"];
  let next = 0;
  const requestNext = (): void => {
    if (next === paths.length) {
      setTimeout(() => server.close(() => console.log("closed")), 30);
      return;
    }
    const path = paths[next++] ?? "/early";
    const request = http.get({ host: "127.0.0.1", port, path, agent: false }, (response) => {
      response.resume();
      response.on("end", () => setTimeout(requestNext, 30));
    });
    request.on("error", (error) => {
      console.log(path, "client error", (error as Error & { code?: string }).code);
      setTimeout(requestNext, 30);
    });
  };
  requestNext();
});
