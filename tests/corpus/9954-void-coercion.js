// A boolean conversion of an effectful void keeps the effect: the operand
// still runs (and may throw) before the constant answer.
let calls = 0
function validate(value) {
  calls++
  if (value < 0) throw new Error("bad " + value)
  return value
}
function check(value) {
  return Boolean(void validate(value))
}
function negated(value) {
  return !void validate(value)
}
try {
  check(-1)
  console.log("no throw")
} catch (error) {
  console.log("threw", error.message)
}
console.log(check(1), negated(2))

// A nested sequence: the inner void expression is the outer sequence's
// result, and its effect still runs.
function nestedCheck(value) {
  return Boolean((calls += 0, void validate(value)))
}
function nestedReport(value) {
  return (calls += 0, void validate(value))
}
try {
  nestedCheck(-3)
  console.log("no throw")
} catch (error) {
  console.log("threw", error.message)
}
nestedReport(4)
console.log(nestedCheck(5), calls)
