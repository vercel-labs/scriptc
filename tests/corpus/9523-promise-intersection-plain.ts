// A value typed as a promise with extra OPTIONAL members (`Promise<T> & {
// note?: string }`) that is an ordinary promise: a member it does not have
// reads as undefined, and the value is awaited, returned and chained as the
// promise it is.
type Noted<T> = Promise<T> & { note?: string; summary?: () => string };

function noteOf<T>(work: Noted<T>): string {
  return work.note ?? "no note";
}
function summaryOf<T>(work: Noted<T>): string {
  return work.summary ? work.summary() : "no summary";
}
const sum: Noted<number> = Promise.resolve(41);
console.log(noteOf(sum), summaryOf(sum), typeof sum.summary);
console.log(await sum.then((value) => value + 1));

// Handed on under the plain promise type.
function plain<T>(work: Noted<T>): Promise<T> {
  return work;
}
async function outcome(work: Promise<string>): Promise<string> {
  try {
    return "done " + (await work);
  } catch (error) {
    return "failed " + (error as Error).message;
  }
}
const early: Noted<string> = Promise.resolve("early");
console.log(await outcome(plain(early)));
const failing: Noted<string> = Promise.reject(new Error("late"));
console.log(await outcome(plain(failing)));

// A member assigned to such a promise in a function nothing calls: the
// statement never runs, so the program is the same as without it.
function stamp<T>(work: Promise<T>, note: string): Noted<T> {
  const stamped = work as Noted<T>;
  stamped.note = note;
  return stamped;
}
console.log(typeof stamp, process.argv.includes("--stamp") ? typeof stamp(sum, "late") : "unstamped");

// Raced and collected with ordinary promises.
const slow: Noted<string> = new Promise((resolve) => setTimeout(() => resolve("slow"), 20));
const quick: Noted<string> = Promise.resolve("quick");
console.log(await Promise.race([plain(slow), plain(quick)]), (await Promise.all([plain(slow), plain(quick)])).join("+"));
