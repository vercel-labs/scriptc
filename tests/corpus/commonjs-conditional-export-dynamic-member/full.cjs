// The full table: `data` is a checked-dynamic value (JSON.parse's answer),
// `mix` is a union (number | string), and the lean table has neither member.
'use strict';

exports.name = 'full';
exports.data = JSON.parse('{"a":1}');
exports.mix = Math.random() > 2 ? 1 : 'x';
