// A source that holds `process` as a value holds its getBuiltinModule with
// it. Reached only through the held object, with ids the compiler cannot
// see, the loader answers the modules it serves, the main thread's
// worker_threads metadata among them, and one id names one module object.
const report = (host, ids) => {
  const [os, path, types, threads] = ids.map((id) => host.getBuiltinModule(id));
  console.log("os", os.platform() === host.platform, typeof os.totalmem());
  console.log("path", path.join("beds", "north", "..", "south"), path.extname("tray.csv"));
  console.log("types", types.isDate(new Date(0)), types.isDate({}), types.isRegExp(/tray/));
  console.log("threads", threads.isMainThread, threads.isInternalThread, threads.threadId);
  console.log("threads", threads.parentPort, threads.workerData);
  console.log("one object", host.getBuiltinModule(`node:${ids[3]}`) === threads);
  console.log("one object", host.getBuiltinModule(ids[1].slice(5)) === path);
  console.log("unknown", host.getBuiltinModule("greenhouse"));
};
const pass = (value) => value;
report(pass(process), ["node:os", "node:path", "node:util/types", "worker_threads"]);
