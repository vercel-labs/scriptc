// util.debuglog from TypeScript: DebugLogger values are callable with a
// typed format string and arguments, `enabled` reads as a boolean, the
// callback receives the typed DebugLoggerFunction, and loggers stored in
// typed slots and records keep working. The program re-runs itself with
// NODE_DEBUG set and unset and prints the child's output with process
// ids normalized.
import { spawnSync } from "node:child_process";
import * as util from "node:util";
import { debuglog } from "node:util";

interface Service {
  name: string;
  log: util.DebugLogger;
}

if (process.argv[2] === "child") {
  const log: util.DebugLogger = debuglog("app");
  const enabled: boolean = log.enabled;
  console.log("app enabled", enabled);
  log("started with %d workers", 4);
  log("hidden %o", { tag: "t", list: [1, 2] });
  const services: Service[] = [
    { name: "db", log: debuglog("app-db") },
    { name: "cache", log: util.debug("app-cache") },
  ];
  for (const service of services) {
    service.log("service %s ready", service.name);
    console.log(service.name, service.log.enabled);
  }
  let seen = "";
  const traced = debuglog("app-trace", (fn: util.DebugLoggerFunction) => {
    seen = typeof fn;
    fn("from the callback");
  });
  traced("first trace %j", { step: 1 });
  console.log("callback saw", seen);
  console.log("end of turn");
} else {
  for (const env of ["app,app-d*,APP-TRACE", ""]) {
    process.env["NODE_DEBUG"] = env;
    const child = spawnSync(process.execPath, [process.argv[1]!, "child"], { encoding: "utf8" });
    console.log(`NODE_DEBUG=${JSON.stringify(env)} status: ${child.status}`);
    console.log(child.stdout);
    console.log(child.stderr.replace(/^([A-Z0-9-]+) \d+: /gm, "$1 <pid>: "));
  }
}
