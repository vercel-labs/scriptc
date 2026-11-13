// process.getBuiltinModule: one namespace object per builtin module,
// reachable by its bare and node:-prefixed names, undefined for names that
// are not builtins, and ERR_INVALID_ARG_TYPE for a non-string id.
const os = process.getBuiltinModule("node:os");
const osBare = process.getBuiltinModule("os");
console.log("os", typeof os, typeof os.arch, os === osBare, os === process.getBuiltinModule("node:os"));
const path = process.getBuiltinModule("path");
console.log("path", path === process.getBuiltinModule("node:path"), typeof path.join, path.sep);
console.log("missing", process.getBuiltinModule("missing"), process.getBuiltinModule("node:missing"));
const loader = process.getBuiltinModule;
console.log("stored", loader("os") === os);
for (const id of [undefined, null, 42, ["os"]]) {
  try {
    process.getBuiltinModule(id);
  } catch (error) {
    console.log("bad", error.code, error.name, error instanceof TypeError);
  }
}
