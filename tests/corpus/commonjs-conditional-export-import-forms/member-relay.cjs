// A require() consumer of a module whose members its branches attach.
'use strict';

const lib = require('./member.cjs');

exports.clock = lib.clock;
exports.label = 'relayed';
