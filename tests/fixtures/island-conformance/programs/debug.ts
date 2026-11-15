import createDebug from "debug";

createDebug.formatArgs = function (args) {
  args[0] = `${this.namespace} ${args[0]}`;
};
createDebug.log = (...args: unknown[]) => {
  console.log(args.map(String).join(" "));
};
createDebug.enable("app:*,-app:quiet");

const log = createDebug("app:main");
const quiet = createDebug("app:quiet");
const child = log.extend("child");

log("starting %s with %d workers", "service", 3);
quiet("never printed");
child("child %o", { a: 1, b: ["x"] });
console.log(log.enabled, quiet.enabled, child.namespace);
console.log(createDebug.enabled("app:other"), createDebug.enabled("lib:other"));
createDebug.disable();
log("after disable");
console.log(log.enabled, typeof log);
