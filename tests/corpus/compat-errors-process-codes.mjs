// The errors the process surface raises with the errors chapter's codes:
// ERR_UNKNOWN_CREDENTIAL from the credential setters and
// ERR_UNCAUGHT_EXCEPTION_CAPTURE_ALREADY_SET from a second capture
// callback; and ERR_SYSTEM_ERROR, whose SystemError carries the `info`
// record and the "A system error occurred" message.
import os from "node:os";

const kind = (e) => (e instanceof TypeError ? "TypeError" : e instanceof RangeError ? "RangeError" : e instanceof Error ? "Error" : typeof e);
function shape(label, fn) {
  try {
    console.log(label, "ok", String(fn()));
  } catch (e) {
    console.log(label, kind(e), e.name, e.code, JSON.stringify(e.message));
  }
}

shape("setuid missing user", () => process.setuid("__scriptc_missing_user__"));
shape("setgid missing group", () => process.setgid("__scriptc_missing_group__"));
shape("setuid max id", () => process.setuid(4294967295));
shape("setgid max id", () => process.setgid(4294967295));

const capture = () => {};
shape("capture set", () => process.setUncaughtExceptionCaptureCallback(capture));
shape("capture twice", () => process.setUncaughtExceptionCaptureCallback(capture));
console.log("has capture", process.hasUncaughtExceptionCaptureCallback());
shape("capture clear", () => process.setUncaughtExceptionCaptureCallback(null));
console.log("has after clear", process.hasUncaughtExceptionCaptureCallback());

shape("setPriority", () => os.setPriority(999999, 0));
// The SystemError's own shape: name "SystemError", the info record, the
// errno the two fields share, and the message naming the libuv call.
try {
  os.setPriority(999999, 0);
} catch (error) {
  const e = error;
  console.log("system shape", e.name, Object.getOwnPropertyNames(e).sort().join(","));
  console.log("system info", e.info && e.info.code, e.info && e.info.syscall, typeof (e.info && e.info.errno), e.errno === (e.info && e.info.errno), e.syscall);
  console.log("system message", e.message.startsWith("A system error occurred: uv_os_setpriority returned E"));
}
