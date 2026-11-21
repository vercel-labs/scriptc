// A socket built with createSocket({ signal }) stops listening to that signal
// when it closes: the accumulator's abort listeners are gone afterwards, so a
// long-lived shared signal does not keep closed sockets alive.
const dgram = require("node:dgram");
const { getEventListeners } = require("node:events");

const controller = new AbortController();
const shared = controller.signal;
const socket = dgram.createSocket({ type: "udp4", signal: shared });
console.log("open", getEventListeners(shared, "abort").length);
socket.close();
setTimeout(() => {
  console.log("closed", getEventListeners(shared, "abort").length);
  const second = dgram.createSocket({ type: "udp4", signal: shared });
  second.close();
  setTimeout(() => {
    console.log("churn", getEventListeners(shared, "abort").length);
    controller.abort();
    setTimeout(() => console.log("aborted", getEventListeners(shared, "abort").length), 10);
  }, 20);
}, 20);
