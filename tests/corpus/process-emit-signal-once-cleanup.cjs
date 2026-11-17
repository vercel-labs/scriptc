// A once signal listener that removes every handler (freeing the signal's
// registry) must not keep the emit reading that registry: the snapshot's
// later once listener still runs, and no handler remains afterwards.
const calls = [];
const first = () => {
  calls.push("first");
  process.off("SIGINT", first);
  process.off("SIGINT", second);
};
const second = () => {
  calls.push("second");
};
process.once("SIGINT", first);
process.once("SIGINT", second);
const answered = process.emit("SIGINT");
console.log(answered, calls.join(","));
console.log(process.emit("SIGINT"), calls.join(","));
