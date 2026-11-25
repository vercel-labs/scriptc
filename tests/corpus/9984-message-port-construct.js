// Only the MessagePort constructor is named: the call still links the
// worker unit and throws Node's ERR_CONSTRUCT_CALL_INVALID.
import { MessagePort } from "node:worker_threads";

try {
  new MessagePort();
  console.log("accepted");
} catch (error) {
  console.log("threw", error.name, error.code, error.message);
}
