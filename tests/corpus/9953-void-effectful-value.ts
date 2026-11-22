// `void` with an effectful operand in a value position: the operand runs for
// its effects and the expression is the undefined value.
let calls = 0
function touch(value: number): number {
  calls++
  return value
}
function early(flag: boolean): number | undefined {
  if (flag) {
    return void touch(1)
  }
  return touch(2)
}
const held: number | undefined = void touch(3)
report()
console.log(early(true), early(false), held, Boolean(void touch(4)), calls)
function report(): void {
  return void touch(5)
}
