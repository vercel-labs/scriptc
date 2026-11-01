// A typeof test in condition position is folded without lowering the
// typeof, so the fold itself must refuse for a Node 24 global native code
// lacks instead of answering "undefined" and taking the else arm (Node
// answers "function"). SC2020, host-global.
declare var WebSocket: { new (url: string): unknown };
if (typeof WebSocket === "function") {
  console.log("websocket");
} else {
  console.log("no websocket");
}
