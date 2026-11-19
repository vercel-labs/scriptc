'use strict';
exports.Widget = function (props) {
  return "widget " + (props === undefined ? "-" : props.label);
};
