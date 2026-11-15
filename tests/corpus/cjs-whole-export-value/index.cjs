// gopd@1.2.0's index.js shape: a feature probe may replace a mutable local
// binding, and the module then exports it whole. Node copies the value at
// `module.exports = $gOPD`, so the probe's null never reaches a requirer.
var $gOPD = Object.getOwnPropertyDescriptor;

if ($gOPD) {
  try {
    $gOPD([], "length");
  } catch (e) {
    $gOPD = null;
  }
}

module.exports = $gOPD;
