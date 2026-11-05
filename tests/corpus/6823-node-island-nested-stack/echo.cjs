// Returns its argument after using some of Node's stack.
function down(n, depth) {
  return depth === 0 ? n : down(n, depth - 1);
}

exports.echo = function (n) {
  return down(n, 500);
};
