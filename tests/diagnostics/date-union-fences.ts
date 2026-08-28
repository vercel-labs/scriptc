// Compiler-synthesized `T | undefined` slots must observe the same Date
// union fence as source-written unions. Each construct below used to reach
// IR validation as an SC9001 internal compiler error.

function defaultDate(value: Date = new Date(0)): number {
  return value.getTime();
}
defaultDate();

function* dates(): Generator<Date, void, unknown> {
  yield new Date(0);
}
for (const value of dates()) console.log(value.getTime());

class DeferredDate {
  value!: Date;
  initialize(): void {
    this.value = new Date(0);
  }
}
const deferred = new DeferredDate();
deferred.initialize();
