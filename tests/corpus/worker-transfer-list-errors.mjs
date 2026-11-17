// postMessage's transfer list is validated before the message is cloned: one
// port listed twice is a duplicate, a value that cannot be transferred at all
// is invalid, and a port inside the message that the list does not name throws.
// (An ArrayBuffer or SharedArrayBuffer in the list keeps scriptc's documented
// refusal, since the runtime does not detach buffers.)
import { MessageChannel } from "node:worker_threads";

const { port1, port2 } = new MessageChannel();
const { port1: a1, port2: a2 } = new MessageChannel();

const attempt = (label, run) => {
  try {
    run();
    console.log(label, "ok");
  } catch (error) {
    console.log(label, error.name, error.code, error.message);
  }
};

attempt("duplicate", () => port1.postMessage("x", [a1, a2, a1]));
attempt("invalid value", () => port1.postMessage("x", [{ a: 1 }]));
attempt("null entry", () => port1.postMessage("x", [null]));
attempt("port not listed", () => port1.postMessage(a1, [a2]));
attempt("listed once", () => port1.postMessage("moved", [a1]));
attempt("send after transfer", () => a1.postMessage("y"));
attempt("closed target", () => {
  port1.close();
  port1.postMessage("z");
});
port2.close();
a2.close();
