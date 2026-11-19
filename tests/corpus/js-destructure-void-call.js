// A call whose inferred return type is `void` answers `undefined` at run
// time, so destructuring it throws Node's TypeError. The hidden source temp
// used to take the `void` type itself, which has no LLVM storage type; it
// takes the checked-dynamic form instead and the pattern lowering throws
// before any binding, spelled as V8 spells the source.
function nothing() {}

function caught(run) {
  try {
    run()
  } catch (error) {
    console.log(error.constructor.name + ": " + error.message)
  }
}

caught(() => {
  const { name } = nothing()
  console.log(name)
})

caught(() => {
  const [first] = nothing()
  console.log(first)
})

function returnsValue() {
  return { name: "map" }
}

const { name } = returnsValue()
console.log(name)
