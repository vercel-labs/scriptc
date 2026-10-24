'use strict';

exports.ready = true;
if (process.env.SCRIPTC_SKIP_LIB === '1') return;
exports.value = 42;
