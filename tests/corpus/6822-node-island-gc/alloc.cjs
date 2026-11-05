// Allocates short-lived objects in rounds and keeps one per round alive
// across calls, so collections run inside the calls and must keep it.
const keep = [];

exports.churn = function (rounds) {
  let count = 0;
  for (let r = 0; r < rounds; r++) {
    const batch = [];
    for (let i = 0; i < 200000; i++) batch.push({ i, s: "x" + i });
    count += batch.length;
    keep.push(batch[r]);
  }
  return count;
};

exports.kept = function () {
  let sum = 0;
  for (const item of keep) sum += item.i;
  return keep.length * 1000000 + sum;
};
