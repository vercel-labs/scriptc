function double(x) {
  return x * 2;
}
function triple(x) {
  return x * 3;
}
module.exports = process.env.SCRIPTC_CORPUS_NEVER_SET ? triple : double;
