// The @types/node spellings of the batch's members: the POSIX credential
// setters and the capture-callback members are optional members (Windows
// has none), so a POSIX program asserts them; process.debugPort and
// process.sourceMapsEnabled read as number and boolean, and
// setSourceMapsEnabled takes exactly a boolean. initgroups is not in
// @types/node's process.d.ts, so its typed use only lives in the untyped
// program.
const uid: number = process.getuid!();
const euid: number = process.geteuid!();
const gid: number = process.getgid!();
const egid: number = process.getegid!();
process.setuid!(uid);
process.seteuid!(euid);
process.setgid!(gid);
process.setegid!(egid);

const hasCallback: boolean = process.hasUncaughtExceptionCaptureCallback();
process.setUncaughtExceptionCaptureCallback(null);
process.setSourceMapsEnabled(hasCallback);

const port: number = process.debugPort;
process.debugPort = port;
const sourceMaps: boolean = process.sourceMapsEnabled;

// Optional member calls and their typed errors.
try {
  process.setgroups!(["scriptc-no-such-group"]);
} catch (error) {
  console.log((error as Error).message);
}
try {
  process.setSourceMapsEnabled(1 as unknown as boolean);
} catch (error) {
  console.log((error as Error).message);
}

// process.ref/unref take any callable-carrying value.
const handle: { ref(): void; unref(): void } = {
  ref() {
    console.log("ref called");
  },
  unref() {
    console.log("unref called");
  },
};
process.ref(handle);
process.unref(handle);
process.ref(null as unknown as { ref(): void });

console.log(uid === euid, gid === egid, hasCallback, port, sourceMaps);

// A Timeout handle is refable through its own methods (the protocol's
// member fallback): unref drops the timer from the loop's keep-alive set,
// ref adds it back, and a timer left unref'd never fires.
const kept: Timeout = setTimeout(() => console.log("timer fired"), 5);
process.unref(kept);
process.ref(kept);
process.unref(setTimeout(() => console.log("unref timer must not fire"), 1000));
