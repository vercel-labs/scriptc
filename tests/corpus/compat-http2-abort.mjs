// node:http2 streams that close while their writable side is still open:
// the 'aborted' event and flag on both ends, in the core API and through
// the compatibility request. A client resets its stream with close(code)
// and with destroy(), a session is destroyed with a request in flight, and
// a stream that had ended its side closes without an abort. `closed` is
// true from the moment the close begins; `destroyed` only from the
// stream's 'close'. The two ends of a connection race, so each records its
// own events and they are printed per end.
import http2 from "node:http2";

function report(name, client, server) {
  console.log(`${name}: client ${client.join(" | ")}`);
  console.log(`${name}: server ${server.join(" | ")}`);
}

// close(NGHTTP2_CANCEL) in the middle of a request body, core API.
await new Promise((resolve) => {
  const clientLines = [];
  const serverLines = [];
  let client;
  const server = http2.createServer();
  server.on("stream", (stream) => {
    stream.on("aborted", () => serverLines.push(`aborted ${stream.aborted} ${stream.destroyed} ${stream.closed}`));
    stream.on("error", (error) => serverLines.push(`error ${error.code}`));
    stream.on("close", () => {
      serverLines.push(`close ${stream.aborted} ${stream.rstCode} ${stream.destroyed} ${stream.closed}`);
      client.close(() => server.close(() => { report("close(code)", clientLines, serverLines); resolve(undefined); }));
    });
    stream.resume();
  });
  server.listen(0, "127.0.0.1", () => {
    client = http2.connect(`http://127.0.0.1:${server.address().port}`);
    const request = client.request({ ":path": "/abort", ":method": "POST" });
    request.on("aborted", () => clientLines.push(`aborted ${request.aborted}`));
    request.on("error", (error) => clientLines.push(`error ${error.code}`));
    request.on("close", () => clientLines.push(`close ${request.aborted} ${request.rstCode} ${request.destroyed}`));
    request.write("partial");
    setTimeout(() => {
      request.close(http2.constants.NGHTTP2_CANCEL);
      clientLines.push(`after close() ${request.aborted} ${request.closed} ${request.destroyed}`);
    }, 50);
  });
});

// destroy() in the middle of a request body; the server uses the
// compatibility API and never ends its response.
await new Promise((resolve) => {
  const clientLines = [];
  const serverLines = [];
  let client;
  const server = http2.createServer((request, response) => {
    request.on("aborted", () => serverLines.push(`aborted ${request.aborted} ${request.complete}`));
    request.on("close", () => serverLines.push(`request close ${request.aborted} ${request.complete}`));
    response.on("close", () => {
      serverLines.push("response close");
      client.close(() => server.close(() => { report("destroy()", clientLines, serverLines); resolve(undefined); }));
    });
    request.resume();
  });
  server.listen(0, "127.0.0.1", () => {
    client = http2.connect(`http://127.0.0.1:${server.address().port}`);
    const request = client.request({ ":path": "/abort", ":method": "POST" });
    request.on("aborted", () => clientLines.push("aborted"));
    request.on("error", (error) => clientLines.push(`error ${error.code}`));
    request.on("close", () => clientLines.push(`close ${request.rstCode} ${request.aborted} ${request.destroyed}`));
    request.write("partial");
    setTimeout(() => {
      request.destroy();
      clientLines.push(`after destroy() ${request.aborted} ${request.destroyed}`);
    }, 50);
  });
});

// A reset after both ends finished writing is not an abort.
await new Promise((resolve) => {
  const clientLines = [];
  const serverLines = [];
  let client;
  const server = http2.createServer();
  server.on("stream", (stream) => {
    stream.on("aborted", () => serverLines.push("aborted"));
    stream.on("error", (error) => serverLines.push(`error ${error.code}`));
    stream.on("close", () => {
      serverLines.push(`close ${stream.aborted} ${stream.rstCode}`);
      client.close(() => server.close(() => { report("ended", clientLines, serverLines); resolve(undefined); }));
    });
    stream.respond({ ":status": 200 });
    stream.end("done");
    stream.resume();
  });
  server.listen(0, "127.0.0.1", () => {
    client = http2.connect(`http://127.0.0.1:${server.address().port}`);
    const request = client.request({ ":path": "/", ":method": "POST" }, { endStream: false });
    request.on("aborted", () => clientLines.push("aborted"));
    request.on("error", (error) => clientLines.push(`error ${error.code}`));
    request.on("close", () => clientLines.push(`close ${request.aborted} ${request.rstCode}`));
    request.on("response", () => {
      request.end();
      request.close(http2.constants.NGHTTP2_CANCEL);
    });
    request.resume();
  });
});

// The client session is destroyed while the server is still answering:
// the server's stream aborted and closes with one of the two teardown
// codes. Whichever end settles the stream first decides which: the
// session's GOAWAY closes it with NGHTTP2_NO_ERROR, the socket's close
// cancels it with NGHTTP2_CANCEL, and the line records that it is one of
// them rather than which. The client's request had ended its side and
// closes quietly.
await new Promise((resolve) => {
  const clientLines = [];
  const serverLines = [];
  const server = http2.createServer();
  server.on("stream", (stream) => {
    stream.on("aborted", () => serverLines.push("aborted"));
    stream.on("error", (error) => serverLines.push(`error ${error.code}`));
    stream.on("close", () => {
      serverLines.push(
        `close ${stream.rstCode === http2.constants.NGHTTP2_NO_ERROR || stream.rstCode === http2.constants.NGHTTP2_CANCEL}`,
      );
      server.close(() => { report("session destroy", clientLines, serverLines); resolve(undefined); });
    });
    stream.respond({ ":status": 200 });
    stream.write("part");
  });
  server.listen(0, "127.0.0.1", () => {
    const client = http2.connect(`http://127.0.0.1:${server.address().port}`);
    client.on("error", (error) => clientLines.push(`session error ${error.code}`));
    client.on("close", () => clientLines.push(`session close ${client.destroyed} ${client.closed}`));
    const request = client.request({ ":path": "/" });
    request.on("error", (error) => clientLines.push(`error ${error.code}`));
    request.on("aborted", () => clientLines.push("aborted"));
    request.on("close", () => clientLines.push(`close ${request.rstCode} ${request.destroyed}`));
    request.on("data", () => {
      client.destroy();
      clientLines.push(`destroyed ${client.destroyed} ${client.closed}`);
    });
  });
});

// Destroying a client session right after it connected leaves the server
// running: its session ends without an unhandled error.
await new Promise((resolve) => {
  const server = http2.createServer();
  server.listen(0, "127.0.0.1", () => {
    const client = http2.connect(`http://127.0.0.1:${server.address().port}`);
    client.on("error", (error) => console.log("client error", error.code));
    client.on("connect", () => {
      client.destroy();
      console.log("destroyed on connect", client.destroyed);
      server.close(() => {
        console.log("server closed");
        resolve(undefined);
      });
    });
  });
});
