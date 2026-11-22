const c = process.config;
console.log("shape", typeof c, Object.isFrozen(c), Object.isFrozen(c.variables), Object.isFrozen(c.target_defaults));
console.log("keys", Object.keys(c).join(","));
console.log("td", Object.keys(c.target_defaults).join(","), c.target_defaults.default_configuration,
  Array.isArray(c.target_defaults.include_dirs), Array.isArray(c.target_defaults.libraries),
  Array.isArray(c.target_defaults.defines), Array.isArray(c.target_defaults.cflags));
const v = c.variables;
console.log("vars", v.host_arch === process.arch, v.target_arch === process.arch,
  v.node_shared, v.node_shared_libuv, v.node_use_openssl,
  typeof v.host_arch);
console.log("i18n", typeof process.config.variables.v8_enable_i18n_support);
// Node's configuration is frozen all the way down: the configurations and
// their own variables objects too, so a write through them does nothing.
const { Release, Debug } = c.target_defaults.configurations;
console.log("nested", Object.isFrozen(c.target_defaults.configurations), Object.isFrozen(Release),
  Object.isFrozen(Release.variables), Object.isFrozen(Debug.variables));
let nestedWrite = "no-throw";
try {
  Release.variables.probe = 1;
} catch (error) {
  nestedWrite = error.name;
}
console.log("nested-write", nestedWrite, typeof Release.variables.probe, "probe" in Release.variables);
