// @requires-libnode
// The properties a program reads from an error island code threw: own
// custom properties, methods of its class, cause, the errno, syscall and
// path of a Node system error, and the errors of an AggregateError. The
// error is a V8 error: what its native view does not hold is read from it.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
try {
  lib.fail(404);
} catch (e) {
  console.log(e.name, e.message, e.status, e.body && e.body.reason, typeof e.retryable, "status" in e, "nope" in e);
  console.log(e.constructor.name, e.missing, e.retryable());
}
try {
  await lib.failAsync(503);
} catch (e) {
  console.log(e.name, e.message, e.status, e.body && e.body.reason, typeof e.retryable === "function" && e.retryable());
}
try {
  lib.failCause();
} catch (e) {
  console.log(e.message, "cause" in e, e.cause.message, e.cause.status, e.cause instanceof Error, e.cause.name);
}
try {
  lib.failFs();
} catch (e) {
  console.log(e.code, typeof e.errno, e.syscall, e.path);
}
try {
  lib.failMany();
} catch (e) {
  console.log(e.name, e.message, e.errors.length, e.errors[1].message);
}
