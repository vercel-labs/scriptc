exports.readX = function (o) {
  return o.x;
};
exports.readTag = function (o) {
  return o.tag;
};
exports.sum = function (list) {
  let s = 0;
  for (let i = 0; i < list.length; i++) s += list[i].x;
  return s;
};
