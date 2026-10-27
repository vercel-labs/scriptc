"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Big5 = exports.ShiftJis = exports.describe = void 0;
class Recogniser {
  name() {
    return 'base';
  }
}
class ShiftJis extends Recogniser {
  name() {
    return 'Shift_JIS';
  }
}
exports.ShiftJis = ShiftJis;
class Big5 extends Recogniser {
  name() {
    return 'Big5';
  }
}
exports.Big5 = Big5;
/** @param {Recogniser} rec */
function describe(rec) {
  return `recogniser ${rec.name()}`;
}
exports.describe = describe;
