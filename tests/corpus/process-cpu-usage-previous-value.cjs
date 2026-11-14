// cpuUsage(prev) and threadCpuUsage(prev) validate only a TRUTHY previous
// value: null, undefined, 0, NaN and the empty string skip validation and
// answer the plain sample. A truthy value reads .user then .system (each
// accessor runs again for the subtraction), so a missing or non-number
// field is the property TypeError, an out-of-range number the
// ERR_INVALID_ARG_VALUE RangeError, and a null, array or primitive prev the
// argument TypeError. The absolute clock values belong to the process, so
// only their types and signs are compared.
"use strict";
function report(label, run) {
  try {
    console.log(label, "->", run());
  } catch (error) {
    console.log(label, error.name, error.code, error.message);
  }
}
/** @param {number} value */
const shape = (value) => typeof value;

const plain = process.cpuUsage();
console.log(
  "plain",
  typeof plain.user,
  typeof plain.system,
  plain.user >= 0,
  plain.system >= 0,
  Number.isInteger(plain.user),
);

const anyValue = /** @type {(value: any) => any} */ ((value) => value);
report("null prev", () => {
  const r = process.cpuUsage(anyValue(null));
  return [typeof r.user, typeof r.system, r.user >= 0].join(",");
});
report("zero prev", () => {
  const r = process.cpuUsage(anyValue(0));
  return [typeof r.user, typeof r.system].join(",");
});
report("nan prev", () => {
  const r = process.cpuUsage(anyValue(NaN));
  return [typeof r.user, typeof r.system].join(",");
});
report("empty string prev", () => {
  const r = process.cpuUsage(anyValue(""));
  return [typeof r.user, typeof r.system].join(",");
});
report("object prev", () => process.cpuUsage(anyValue({})));
report("string field", () => process.cpuUsage(anyValue({ user: "1", system: 2 })));
report("negative field", () => process.cpuUsage(anyValue({ user: -1, system: 0 })));
report("infinite field", () => process.cpuUsage(anyValue({ user: 1, system: Infinity })));
report("string prev", () => process.cpuUsage(anyValue("prev")));
report("number prev", () => process.cpuUsage(anyValue(5)));
report("array prev", () => process.cpuUsage(anyValue([1, 2])));

const calls = [];
const counted = {
  get user() {
    calls.push("u");
    return 1;
  },
  get system() {
    calls.push("s");
    return 2;
  },
};
report("getters", () => {
  const r = process.cpuUsage(anyValue(counted));
  return calls.join(",") + " " + shape(r.user);
});

let reads = 0;
const shifting = {
  get user() {
    reads += 1;
    return reads === 1 ? 1 : "5";
  },
  system: 0,
};
report("second read", () => {
  const r = process.cpuUsage(anyValue(shifting));
  return typeof r.user + " " + reads;
});

report("thread prev", () => {
  const r = process.threadCpuUsage(anyValue({ user: 1, system: 2 }));
  return [typeof r.user, typeof r.system, Number.isInteger(r.user)].join(",");
});
report("thread invalid", () => process.threadCpuUsage(anyValue({ user: 1 })));
