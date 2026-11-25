'use strict';
// A sibling dependency replaces late's module.exports during the graph's
// evaluation; the importing module's default binding was made when late
// finished evaluating and keeps that value.
const late = require('./late.cjs');
late.swap();
