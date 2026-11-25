// Required and mutated before any ESM module imports the module: the
// namespace Node builds at that import copies the replaced export.
const pkg = require("./pkg.cjs")
pkg.rename()
