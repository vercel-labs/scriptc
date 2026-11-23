// A function imported from a CommonJS package whose export is chosen at run
// time (React's shape), called while the importing module evaluates: Node has
// the chosen module's function by then.
import { mk } from "conditional-pkg"

const chosen = mk()
console.log(chosen)
