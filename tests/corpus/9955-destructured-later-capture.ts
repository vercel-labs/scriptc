// A closure created above a destructuring declaration reads its targets:
// the bindings are in their temporal dead zone when the closure is created
// and filled by the declaration before the closure runs.
interface Control {
  show(): void
  hide(): void
}

let shown = 0
let hidden = 0
const control: Control = {
  show() {
    shown++
  },
  hide() {
    hidden++
  },
}

function make(cb: { run: () => void }): { run: () => void } {
  return cb
}

function outer(source: Control): number {
  const kit = make({
    run() {
      hide()
      show()
    },
  })
  const { show, hide } = source
  kit.run()
  return shown * 10 + hidden
}

console.log(outer(control), outer(control))
