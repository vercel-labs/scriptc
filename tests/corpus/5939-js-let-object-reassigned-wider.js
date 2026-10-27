// An untyped `let` that starts as one object literal and is later
// assigned object literals with more properties holds each object as
// written: the added properties read back, and properties an object lacks
// read as undefined.
function zip(left, right) {
  let state = { _tag: "PullBoth" };
  const out = [];
  for (let i = 0; i < left.length; i++) {
    if (state._tag === "PullBoth") state = { _tag: "PullLeft", right: right[i] };
    else if (state._tag === "PullLeft") {
      out.push([left[i], state.right]);
      state = { _tag: "PullBoth" };
    }
  }
  return { out, last: state._tag, pending: state.right };
}
console.log(zip([1, 2, 3, 4], ["a", "b", "c", "d"]));

let point = { x: 1 };
const update = () => {
  point = { x: 2, y: 3 };
};
console.log(point.y, Object.keys(point));
update();
console.log(point.x, point.y, Object.keys(point), JSON.stringify(point));

let config = { name: "base" };
config = { ...config, debug: true };
console.log(config.debug, config);
