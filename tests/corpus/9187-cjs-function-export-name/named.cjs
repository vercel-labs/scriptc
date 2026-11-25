module.exports = function wordform(word, count) {
  return count === 1 ? word : word + "s";
};
