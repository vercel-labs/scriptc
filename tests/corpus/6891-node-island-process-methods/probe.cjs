const methods = ["on", "addListener", "prependListener", "emit"];

exports.probe = function () {
  const lines = [];
  lines.push(`on === addListener: ${process.on === process.addListener}`);
  for (const key of methods) {
    const fn = process[key];
    lines.push(
      `${key}: name ${fn.name}, length ${fn.length}, prototype ${typeof fn.prototype}, own ${Object.hasOwn(process, key)}`,
    );
  }
  const keys = Object.keys(process);
  lines.push(`Object.keys has: [${methods.filter((key) => keys.includes(key)).join(", ")}]`);
  const inherited = [];
  for (const key in process) if (!keys.includes(key)) inherited.push(key);
  lines.push(`for...in inherited: ${inherited.join(", ")}`);
  const proto = Object.getPrototypeOf(process);
  lines.push(`prototype: ${proto.constructor.name}, below it ${Object.getPrototypeOf(proto) === require("node:events").prototype ? "EventEmitter.prototype" : "something else"}`);
  // The wrappers still record listeners: a once listener runs once.
  let runs = 0;
  process.once("probe-event", () => runs++);
  process.emit("probe-event");
  process.emit("probe-event");
  lines.push(`once listener runs: ${runs}`);
  return lines.join("\n");
};
