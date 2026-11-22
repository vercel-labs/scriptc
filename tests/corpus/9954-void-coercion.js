// A boolean conversion of an effectful void keeps the effect: the operand
// still runs (and may throw) before the constant answer.
function validate(value) {
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
