// http2session.goaway([code[, lastStreamID[, opaqueData]]]) and the
// 'goaway' event it raises on the peer. A GOAWAY with NO_ERROR names the
// last stream the sender processed and leaves the session draining until
// both ends finish; one with an error code destroys the receiving session
// with ERR_HTTP2_SESSION_ERROR. The two ends race, so each phase prints its
// lines sorted, and only the FIRST received GOAWAY is recorded (a closing
// session repeats the frame as its graceful close completes).
import http2 from "node:http2";

// The server finishes the request, sends GOAWAY(0, last, "bye"), then
// closes. The client reads the code, lastStreamID and opaque data.
await new Promise((resolve) => {
  const lines = [];
  const server = http2.createServer();
  server.on("stream", (stream) => {
    stream.respond({ ":status": 200 });
    stream.end("ok");
    stream.session.goaway(0, stream.id, Buffer.from("bye"));
    stream.session.close();
    server.close();
  });
  server.listen(0, "127.0.0.1", () => {
    const client = http2.connect(`http://127.0.0.1:${server.address().port}`);
    let received = 0;
    client.on("goaway", (code, last, opaque) => {
      received += 1;
      if (received > 1) return;
      lines.push(`goaway ${code} ${last} ${opaque === undefined ? "none" : opaque.toString()}`);
      lines.push(`closed during goaway ${client.closed} ${client.destroyed}`);
    });
    client.on("close", () => {
      lines.push(`closed after goaway ${client.closed} ${client.destroyed}`);
      setTimeout(() => {
        console.log(lines.sort().join(" | "));
        resolve();
      }, 20);
    });
    client.on("connect", () => {
      const request = client.request({ ":path": "/" });
      request.resume();
      request.end();
    });
  });
});

// An error GOAWAY destroys the receiving session after the 'goaway' event;
// the session's own error carries Node's code and message.
await new Promise((resolve) => {
  const lines = [];
  const server = http2.createServer();
  server.on("session", (session) => session.goaway(http2.constants.NGHTTP2_ENHANCE_YOUR_CALM));
  server.listen(0, "127.0.0.1", () => {
    const client = http2.connect(`http://127.0.0.1:${server.address().port}`);
    client.on("goaway", (code) => lines.push(`goaway ${code}`));
    client.on("error", (error) => lines.push(`session error ${error.code} ${error.message}`));
    client.on("close", () => {
      lines.push("close");
      server.close(() => {
        console.log(lines.sort().join(" | "));
        resolve();
      });
    });
  });
});
