"use strict";
// React's development jsx-runtime wraps require("react") in an IIFE: the
// module evaluates on the IIFE's first call and every later require answers
// the same exports object.
var React = (function () {
  return require("./react.cjs");
})();
function jsx(type, props) {
  return React.createElement(type, props);
}
module.exports = { jsx: jsx, Fragment: React.Fragment };
