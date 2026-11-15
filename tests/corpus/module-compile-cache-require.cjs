// @env: NODE_DISABLE_COMPILE_CACHE=1
// node:module's compile cache family through require.
const nodeModule = require("node:module");
const result = nodeModule.enableCompileCache?.();
console.log(
  result,
  nodeModule.getCompileCacheDir(),
  nodeModule.flushCompileCache(),
  typeof nodeModule.enableCompileCache,
);
const { enableCompileCache, constants } = require("module");
console.log(
  enableCompileCache("/nonexistent/compile-cache"),
  constants.compileCacheStatus.DISABLED,
  constants === nodeModule.constants,
);
