// The global WebSocket's constructor and state validation: Node's
// DOMException shapes for a bad URL, scheme, fragment and subprotocol list,
// the initial attribute values, the calls that are invalid in CONNECTING,
// and the events a refused connection reports.
function show(label, run) {
  try {
    run();
    console.log(label, "ok");
  } catch (error) {
    console.log(label, error.name, error.message);
  }
}

show("bad url", () => new WebSocket("not a url"));
show("ftp", () => new WebSocket("ftp://example.com"));
show("fragment", () => new WebSocket("ws://example.com/#x"));
show("duplicate protocols", () => new WebSocket("ws://example.com", ["a", "a"]));
show("bad protocol token", () => new WebSocket("ws://example.com", "a b"));

const socket = new WebSocket("ws://127.0.0.1:1/");
console.log(
  "initial",
  socket.readyState,
  socket.binaryType,
  socket.protocol,
  socket.extensions,
  socket.bufferedAmount,
  socket.url.endsWith("/")
);
show("send connecting", () => socket.send("x"));
show("send without data", () => socket.send());
socket.binaryType = "nope";
console.log("binaryType", socket.binaryType);

socket.onerror = (event) => console.log("error", event.type, event.isTrusted);
socket.onclose = (event) => {
  console.log("close", event.code, event.reason, event.wasClean, event.type);
};
