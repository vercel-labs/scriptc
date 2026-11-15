// A binding written once at the top level before the export statement:
// Node copies the value that the write produced.
'use strict';

var count = 0;
count = count + 1;
count = count + 1;

module.exports = count;
