// A closure created above an array destructuring reads an element the array
// may not have: the binding is initialized to undefined, as in Node, not
// converted to the element type at the destructuring.
function make(cb: { run: () => void }): { run: () => void } {
  return cb
}
function first(xs: number[]): void {
  const kit = make({
    run() {
      const seen: number | undefined = value
      console.log("seen", seen)
    },
  })
  const [value] = xs
  kit.run()
}
first([7])
first([])
