// os members read the parameters they declare and ignore the rest, but a
// JavaScript caller still evaluates every argument, in source order. The
// validation Node performs on the arguments it does read is part of the
// contract: the checked name, the code, and the rendered value.
const os = require("os");

function shape(label, fn) {
  try {
    console.log(label, "ok", String(fn()));
  } catch (e) {
    console.log(label, [e.constructor.name, e.name, e.code, e.message, e instanceof Error].join(" | "));
  }
}

// The no-argument members answer exactly what the bare call answers, with
// the ignored arguments evaluated first.
console.log("arch", os.arch(1) === os.arch());
console.log("platform", os.platform(console.log("platform side")) === os.platform());
console.log("hostname", os.hostname(1) === os.hostname());
console.log("release", os.release(1) === os.release());
console.log("version", os.version(1) === os.version());
console.log("machine", os.machine(1) === os.machine());
console.log("type", os.type(1) === os.type());
console.log("endianness", os.endianness(1) === os.endianness());
console.log("tmpdir", os.tmpdir(1) === os.tmpdir());
console.log("homedir", os.homedir(1) === os.homedir());
console.log("availableParallelism", os.availableParallelism(1) === os.availableParallelism());
console.log("totalmem", os.totalmem(1, 2) === os.totalmem());
console.log("freemem", os.freemem(console.log("freemem side")) >= 0);
console.log("uptime", typeof os.uptime(1) === "number");
console.log("loadavg", os.loadavg(1).length === 3);
console.log("cpus", os.cpus(1).length === os.cpus().length);
console.log("networkInterfaces", typeof os.networkInterfaces(1) === "object");

// userInfo reads only the options object; extras evaluate after it.
console.log("userInfo", os.userInfo(1, 2).username === os.userInfo().username);
console.log("userInfo options", os.userInfo({}, console.log("userInfo side")).uid === os.userInfo().uid);
const buffered = os.userInfo({ encoding: "buffer" }, console.log("userInfo encoding side"));
console.log("userInfo buffer", typeof buffered.homedir, buffered.homedir.length > 0);

// The priorities: an omitted or extra argument only evaluates, and the two
// validators render their own names.
console.log("getPriority", os.getPriority(0, 1) === os.getPriority());
console.log("setPriority", (os.setPriority(0, 0, 9), os.setPriority(0, 0), "done"));

shape("getPriority('x')", () => os.getPriority("x"));
shape("getPriority(1.5)", () => os.getPriority(1.5));
shape("getPriority(2**31)", () => os.getPriority(2 ** 31));
shape("setPriority()", () => os.setPriority());
shape("setPriority('p')", () => os.setPriority("p"));
shape("setPriority(0, 99)", () => os.setPriority(0, 99));
shape("setPriority(0, -99)", () => os.setPriority(0, -99));
shape("setPriority(1.5, 0)", () => os.setPriority(1.5, 0));
shape("setPriority(0, 1.5)", () => os.setPriority(0, 1.5));

// A getpriority failure is a SystemError: Node's generic ERR_SYSTEM_ERROR
// carries the uv call name, its result name and the errno.
try {
  os.getPriority(2147483646);
  console.log("getPriority far pid", "no throw");
} catch (e) {
  console.log(
    "getPriority far pid",
    e.name,
    e.code,
    typeof e.errno,
    e.errno < 0,
    e.syscall,
    e.message,
    e instanceof Error,
  );
}
