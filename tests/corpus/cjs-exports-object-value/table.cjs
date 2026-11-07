// A module whose exports object is a table literal: every property form is
// an own property of the object a requirer receives.
const first = 1;
const second = 2;

module.exports = {
  answer: 42,
  first,
  second,
  sum: first + second,
  double() {
    return second * 2;
  },
};
