// worker_threads.SHARE_ENV through the loader of a held `process` object, in
// a program that uses the worker API itself: the module object answers the
// symbol the import binds, whichever spelling of the id reaches the loader.
import { SHARE_ENV } from "node:worker_threads";

const pass = (value) => value;
const host = pass(process);
const ids = ["worker_threads", "node:worker_threads"];
for (const id of ids) {
  const threads = host.getBuiltinModule(id);
  console.log(id, typeof threads.SHARE_ENV, threads.SHARE_ENV === SHARE_ENV);
}
console.log("description", host.getBuiltinModule(ids[0]).SHARE_ENV.description);
console.log("main thread", host.getBuiltinModule(ids[1]).isMainThread);
