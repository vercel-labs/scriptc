'use strict';
// The UMD wrapper every bundled package ships: module.exports takes the
// factory's value inside a function that runs when the module does.
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.Lib = factory();
  }
})(this, function () {
  return {
    greet: function (name) {
      return 'hi ' + name;
    },
    value: 7,
  };
});
