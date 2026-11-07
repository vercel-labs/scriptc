// node:http2 session members: ping() with and without a payload and its
// (err, duration, payload) callback, the 'ping' event on the peer, a ping
// sent before the session connected (cancelled: the callback gets the
// error alone), connecting, and getPackedSettings() and
// getUnpackedSettings() with their errors. The two ends race, so each
// records its own lines.
import http2 from "node:http2";

const packed = http2.getPackedSettings({
  headerTableSize: 100,
  enablePush: false,
  maxConcurrentStreams: 7,
  initialWindowSize: 1000,
  maxFrameSize: 20000,
  maxHeaderListSize: 500,
  enableConnectProtocol: true,
});
console.log(packed.toString("hex"), packed.length);
console.log(http2.getPackedSettings().length, http2.getPackedSettings({}).length);
console.log(JSON.stringify(http2.getUnpackedSettings(packed)));
console.log(JSON.stringify(http2.getUnpackedSettings(Buffer.from([0, 9, 0, 0, 0, 5, 0, 4, 0, 0, 1, 0]))));
for (const bad of [{ maxFrameSize: 1 }, { initialWindowSize: -1 }, { enablePush: 1 }, { headerTableSize: "x" }]) {
  try {
    http2.getPackedSettings(bad);
    console.log("no error");
  } catch (error) {
    console.log(error.name, error.code, error.message);
  }
}
try {
  http2.getUnpackedSettings(Buffer.alloc(5));
} catch (error) {
  console.log(error.name, error.code, error.message);
}

await new Promise((resolve) => {
  const clientLines = [];
  const serverLines = [];
  const server = http2.createServer();
  server.on("session", (session) => {
    let pings = 0;
    session.on("ping", (payload) => serverLines.push(`ping ${++pings} ${payload.length} ${pings === 2 ? payload.toString() : "-"}`));
    session.on("close", () => serverLines.push("session close"));
  });
  server.listen(0, "127.0.0.1", () => {
    const client = http2.connect(`http://127.0.0.1:${server.address().port}`);
    clientLines.push(`connecting ${client.connecting}`);
    client.ping((error, duration) => clientLines.push(`early ping ${error.code} ${error.message} ${duration}`));
    client.on("close", () => {
      try {
        client.ping(() => {});
      } catch (error) {
        clientLines.push(`${error.name} ${error.code} ${error.message}`);
      }
      server.close(() => {
        console.log(`client ${clientLines.join(" | ")}`);
        console.log(`server ${serverLines.join(" | ")}`);
        resolve(undefined);
      });
    });
    client.on("connect", () => {
      clientLines.push(`connected ${client.connecting}`);
      client.ping((error, duration, payload) => {
        clientLines.push(`ping 1 ${error} ${typeof duration} ${payload.length}`);
        client.ping(Buffer.from("abcdefgh"), (error2, duration2, payload2) => {
          clientLines.push(`ping 2 ${error2} ${duration2 >= 0} ${payload2.toString()}`);
          try {
            client.ping(Buffer.from("short"), () => {});
          } catch (error3) {
            clientLines.push(`${error3.name} ${error3.code} ${error3.message}`);
          }
          client.close();
        });
      });
    });
  });
});
