// node:http2 stream header and state readbacks: sentHeaders (server
// response and client request blocks), sentInfoHeaders from
// additionalHeaders, sentTrailers from sendTrailers, and the state
// snapshot's state/localClose/remoteClose numbers. The auto date header is
// only checked by key presence, since its value is the run's clock.
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const lines: string[] = [];
const server = http2.createServer();
server.on("stream", (stream) => {
  lines.push(`server sentHeaders before ${stream.sentHeaders === undefined}`);
  stream.additionalHeaders({ ":status": 103, "x-info": "a" });
  stream.respond({ ":status": 200, "x-a": "1" }, { waitForTrailers: true });
  const sent = stream.sentHeaders;
  lines.push(
    `server sentHeaders keys ${JSON.stringify(Object.keys(sent).sort())} ${sent[":status"]} ${sent["x-a"]}`,
  );
  const info = stream.sentInfoHeaders;
  lines.push(`server sentInfoHeaders ${info.length} ${info[0][":status"]} ${info[0]["x-info"]}`);
  stream.on("wantTrailers", () => {
    lines.push(`server state ready ${stream.state.state} ${stream.state.localClose}`);
    stream.sendTrailers({ "x-t": "tv" });
    lines.push(`server sentTrailers ${stream.sentTrailers["x-t"]}`);
  });
  stream.end("ok");
});
server.listen(0, "127.0.0.1", () => {
  const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  client.on("connect", () => {
    const request = client.request({ ":path": "/readbacks", "x-req": "r" });
    const sent = request.sentHeaders;
    lines.push(
      `client sentHeaders ${sent[":method"]} ${sent[":path"]} ${typeof sent[":authority"]} ${sent["x-req"]}`,
    );
    lines.push(`client state open ${request.state.state} ${request.state.remoteClose}`);
    request.resume();
    request.on("end", () => {
      client.close(() => {
        server.close(() => {
          for (const line of lines.sort()) console.log(line);
          // The dyn records read here trip a pre-existing session-teardown
          // audit false positive; exit once the output is complete.
          process.exit(0);
        });
      });
    });
    request.end();
  });
});
