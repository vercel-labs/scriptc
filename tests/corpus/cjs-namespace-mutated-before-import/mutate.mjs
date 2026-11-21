// Required and mutated before any ESM module imports the package: the
// namespace Node builds at that import copies the replaced export.
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const pkg = require("late-pkg")
pkg.rename()
