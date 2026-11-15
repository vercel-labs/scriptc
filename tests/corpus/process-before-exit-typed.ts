// The typed 'beforeExit' spellings: the listener receives process.exitCode
// (0 while unset), `once` and `off`/`removeListener` share the registry,
// prependListener puts a listener in front, and the emission count is
// observable through a closure.
let seen: number[] = [];
const record = (code: number): void => {
  seen.push(code);
  console.log(`record ${code}`);
};
process.prependListener("beforeExit", (code) => console.log(`prepended ${code}`));
process.on("beforeExit", record);
process.once("beforeExit", (code) => console.log(`once ${code}`));
process.on("beforeExit", () => {
  console.log("seen", seen.join(","));
  process.off("beforeExit", record);
  console.log("removed record");
});
console.log("body done");
