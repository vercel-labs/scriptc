// A declaration that does not describe the value the runtime produces: the
// checker types the context null, so the guarded function is inferred never
// and the destructured member never, while the value exists in JavaScript.
import { useContext } from "./ctx.js"

const C = {}
function useThing() {
  const context = useContext(C)
  if (!context) throw new Error("no context")
  return context
}
function render(input = {}) {
  const { field } = useThing()
  return field ? field.props(input) : input
}
console.log(render({ a: 1 }))
