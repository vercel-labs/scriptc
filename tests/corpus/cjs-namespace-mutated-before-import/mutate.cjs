// Required and mutated before any ESM module imports the package: the
// namespace Node builds at that import copies the replaced export.
const pkg = require("late-pkg")
pkg.rename()
