// An export written in both arms of a feature test, its first write naming a
// const. Node's export object copies the const's value there; the second arm
// writes the export, never the const, so `label` stays 'base'.
'use strict';
const label = 'base';
if (process.env.CJS_EXPORT_CONST_MODE === 'other') {
  exports.label = label;
} else {
  exports.label = 'other';
}
exports.mode = label;
