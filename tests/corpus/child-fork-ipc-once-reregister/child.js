// A once listener that re-registers itself while it runs: the registration
// it adds during the dispatch must survive the once entry's own removal.
let runs = 0;
const listener = () => {
  runs += 1;
  process.send({ kind: "run" + runs });
  if (runs < 2) process.once("message", listener);
};
process.once("message", listener);
