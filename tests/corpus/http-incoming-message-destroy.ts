// IncomingMessage.destroy([error]): a message the reader has not finished is
// 'aborted' the moment destroy() runs, on the same tick as the call.
import * as http from "node:http";

function codeOf(error: Error): string {
  const caught = error as NodeJS.ErrnoException;
  return `${caught.name} ${caught.message}`;
}

const server = http.createServer((request, response) => {
  const path = request.url ?? "";
  request.on("error", (error: Error) => console.log(path, "error", codeOf(error)));
  if (path === "/early") {
    request.on("aborted", () => console.log(path, "aborted", request.aborted, request.complete));
    request.destroy();
    console.log(path, "after", request.destroyed, request.aborted);
    request.destroy();
    return;
  }
  request.on("aborted", () => console.log(path, "aborted", request.aborted));
  request.on("close", () => console.log(path, "close", request.aborted, request.destroyed, request.complete));
  request.on("data", (chunk: Buffer) => console.log(path, "data", chunk.toString()));
  request.on("end", () => {
    console.log(path, "end");
    if (path === "/payload") {
      request.destroy(new Error("boom"));
      console.log(path, "after", request.destroyed, request.aborted);
    } else {
      // destroy(undefined) reports no error, like destroy().
      request.destroy(undefined);
    }
    response.end("late " + path);
  });
  request.resume();
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;

function hit(path: string, method: string, body?: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const request = http.request({ host: "127.0.0.1", port, path, method, agent: false });
    request.on("error", (error: Error) => console.log(path, "client error", codeOf(error)));
    request.on("response", (response) => {
      console.log(path, "client status", response.statusCode);
      let text = "";
      response.on("data", (chunk: Buffer) => {
        text += chunk.toString();
      });
      response.on("end", () => console.log(path, "client body", text));
    });
    request.on("close", () => resolve());
    request.end(body ?? "");
  });
}

await hit("/early", "POST", "body");
await hit("/done", "POST", "hello");
await hit("/payload", "POST", "hello");

server.close(() => console.log("closed"));
