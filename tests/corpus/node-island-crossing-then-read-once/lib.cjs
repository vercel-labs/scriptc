"use strict";
// A thenable whose `then` is a getter with state. Await reads `then` once.
exports.once = () => {
  let reads = 0;
  return {
    get then() {
      reads++;
      return reads === 1 ? (resolve) => resolve("the function of the first read") : undefined;
    },
    reads: () => reads,
  };
};
exports.counting = () => {
  let reads = 0;
  return {
    get then() {
      reads++;
      return (resolve) => resolve(`resolved by read ${reads}`);
    },
  };
};
