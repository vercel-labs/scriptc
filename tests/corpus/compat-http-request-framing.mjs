// How a request body is framed, by method and by client. Node's
// ClientRequest sends no framing header for GET, HEAD, DELETE, OPTIONS,
// TRACE and CONNECT when the head goes out before the body length is
// known (flushHeaders(), a first write()), and chunks the others; fetch()
// frames every body, a known length with Content-Length and a stream with
// chunked encoding, whatever the method. A raw peer prints the request
// line, the framing headers and the body bytes it received.
import http from "node:http";
import net from "node:net";

const server = net.createServer((socket) => {
  let text = "";
  let done = false;
  socket.on("data", (chunk) => {
    text += chunk;
    const end = text.indexOf("\r\n\r\n");
    if (done || end < 0) return;
    const lines = text.slice(0, end).split("\r\n");
    const body = text.slice(end + 4);
    const framing = lines.filter((line) => /^(content-length|transfer-encoding):/i.test(line)).map((line) => line.toLowerCase());
    const length = framing.find((line) => line.startsWith("content-length:"));
    const complete = length
      ? body.length >= Number(length.slice(15))
      : framing.includes("transfer-encoding: chunked")
        ? body.endsWith("0\r\n\r\n")
        : body.length >= Number(lines.find((line) => line.startsWith("x-raw-length:"))?.slice(13) ?? 0);
    if (!complete) return;
    done = true;
    console.log(lines[0], JSON.stringify(framing), JSON.stringify(body));
    socket.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
const port = server.address().port;
const agent = new http.Agent();

// http.request: the head leaves before the length is known.
function early(method, send) {
  return new Promise((resolve) => {
    const request = http.request({ port, host: "127.0.0.1", method, agent, headers: { "x-raw-length": "3" } }, (response) => {
      response.resume();
      response.on("end", () => resolve(undefined));
    });
    send(request);
  });
}
await early("GET", (request) => {
  request.flushHeaders();
  request.write("raw");
  request.end();
});
await early("DELETE", (request) => {
  request.write("raw");
  request.end();
});
await early("OPTIONS", (request) => {
  request.write("ra");
  request.end("w");
});
await early("POST", (request) => {
  request.flushHeaders();
  request.end("raw");
});
await early("PUT", (request) => {
  request.write("raw");
  request.end();
});
agent.destroy();

// fetch: every body is framed.
const url = "http://127.0.0.1:" + port + "/";
function stream() {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("streamed"));
      controller.close();
    },
  });
}
let response = await fetch(url, { method: "DELETE", body: "gone" });
console.log("fetch", response.status);
response = await fetch(url, { method: "DELETE", body: stream(), duplex: "half" });
console.log("fetch", response.status);
response = await fetch(url, { method: "OPTIONS", body: "opts" });
console.log("fetch", response.status);
response = await fetch(url, { method: "POST", body: stream(), duplex: "half" });
console.log("fetch", response.status);
server.close();
