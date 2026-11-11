// The host facts whose values are deterministic on one machine, printed
// byte for byte: Node and the compiled binary run on the same host, so both
// sides must answer the same strings. The values that change between two
// processes (free memory, load average, uptime) print their documented
// invariants instead.
import * as os from "node:os";

console.log("platform", JSON.stringify(os.platform()));
console.log("arch", JSON.stringify(os.arch()));
console.log("machine", JSON.stringify(os.machine()));
console.log("type", JSON.stringify(os.type()));
console.log("release", JSON.stringify(os.release()));
console.log("version", JSON.stringify(os.version()));
console.log("hostname", JSON.stringify(os.hostname()));
console.log("endianness", JSON.stringify(os.endianness()));
console.log("EOL", JSON.stringify(os.EOL));
console.log("devNull", JSON.stringify(os.devNull));

// The declared types flow into ordinary values.
const platform: string = os.platform();
const endianness: "BE" | "LE" = os.endianness();
const eol: "\r\n" | "\n" = os.EOL;
console.log("typed", platform === os.platform(), endianness === os.endianness(), eol === os.EOL);

// platform()/arch() are the process values Node derives them from, and the
// uname fields are non-empty strings.
console.log("process", os.platform() === process.platform, os.arch() === process.arch);
console.log(
  "nonempty",
  os.type().length > 0,
  os.release().length > 0,
  os.version().length > 0,
  os.machine().length > 0,
  os.hostname().length > 0,
);

// Memory in bytes: integers, and free memory within total memory.
const total = os.totalmem();
const free = os.freemem();
console.log("totalmem", Number.isInteger(total), total > 0);
console.log("freemem", Number.isInteger(free), free > 0, free <= total);

// Uptime in seconds, non-decreasing across calls in one process.
const up = os.uptime();
console.log("uptime", Number.isFinite(up), up > 0, os.uptime() >= up);

// The three 1/5/15-minute load averages.
const load = os.loadavg();
console.log("loadavg", Array.isArray(load), load.length, load.every((v) => Number.isFinite(v) && v >= 0));

// The default thread count is a positive integer.
const parallelism = os.availableParallelism();
console.log("availableParallelism", Number.isInteger(parallelism), parallelism >= 1);

// Each call answers the same value: the host does not change under the program.
console.log(
  "stable",
  os.platform() === platform,
  os.arch() === os.arch(),
  os.machine() === os.machine(),
  os.type() === os.type(),
  os.release() === os.release(),
  os.version() === os.version(),
  os.hostname() === os.hostname(),
  os.endianness() === endianness,
);
