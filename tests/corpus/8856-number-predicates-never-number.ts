// Number.isFinite, isNaN, isInteger and isSafeInteger never coerce: an
// argument that is not a number answers false, after it has evaluated.

let calls = 0;
function text(): string {
  calls++;
  return "12";
}
function flag(): boolean {
  calls++;
  return true;
}
function big(): bigint {
  calls++;
  return 12n;
}
function list(): number[] {
  calls++;
  return [1];
}
function record(): { n: number } {
  calls++;
  return { n: 1 };
}
function nothing(): undefined {
  calls++;
  return undefined;
}
function textOrFlag(pick: boolean): string | boolean {
  calls++;
  return pick ? "1" : false;
}
function numberOrText(pick: boolean): number | string {
  calls++;
  return pick ? 7 : "7";
}

console.log(Number.isFinite(text()), Number.isNaN(text()), Number.isInteger(text()), Number.isSafeInteger(text()));
console.log(Number.isFinite(flag()), Number.isNaN(flag()), Number.isInteger(flag()), Number.isSafeInteger(flag()));
console.log(Number.isFinite(big()), Number.isInteger(big()));
console.log(Number.isFinite(list()), Number.isInteger(record()), Number.isNaN(nothing()));
console.log(Number.isFinite(textOrFlag(true)), Number.isInteger(textOrFlag(false)));
console.log(Number.isFinite(numberOrText(true)), Number.isFinite(numberOrText(false)));
console.log(Number.isFinite(null), Number.isNaN("NaN"), Number.isInteger("1"));
console.log("calls", calls);
