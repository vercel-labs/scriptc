// The compatibility pair's trailers and informational responses:
// request.trailers/rawTrailers carry the block the client sent after its
// body, res.writeContinue/writeEarlyHints send 1xx blocks before the
// response, and res.addTrailers sends the response's trailer block when the
// stream asks for it. The two ends race, so the lines are printed sorted.
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const lines: string[] = [];
const server = http2.createServer((request, response) => {
  request.resume();
  request.on("end", () => {
    lines.push(`req trailers ${JSON.stringify(request.trailers)}`);
    lines.push(`req rawTrailers ${request.rawTrailers.join(",")}`);
    lines.push(`continue sent ${response.writeContinue()}`);
    lines.push(`hints sent ${response.writeEarlyHints({ link: "</style.css>" })}`);
    lines.push(`info sent ${response.writeInformation(102, { "x-info": "1" })}`);
    response.setHeader("x-a", "1");
    response.addTrailers({ "x-done": "1" });
    response.end("ok");
  });
});

await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", () => {
    const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    const request = client.request(
      { ":path": "/", ":method": "POST" },
      { waitForTrailers: true },
    );
    request.on("wantTrailers", () => {
      lines.push("client wantTrailers");
      request.sendTrailers({ "x-req-trailer": "r" });
    });
    request.on("headers", (headers) => lines.push(`headers ${headers[":status"]}`));
    request.on("continue", () => lines.push("continue"));
    request.on("response", (headers) => lines.push(`response ${headers[":status"]} ${headers["x-a"]}`));
    request.on("trailers", (trailers) => lines.push(`trailers ${trailers["x-done"]}`));
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => lines.push(`data ${chunk}`));
    request.on("end", () => {
      lines.push("end");
      client.close(() => server.close(() => resolve()));
    });
    request.write("body");
    request.end();
  });
});

for (const line of lines.sort()) console.log(line);
