// A let that is never reassigned, exported in a table.
'use strict';

let tabReplace = '  ';
let calls = [];

function render(text) {
  calls.push(text);
  return text.split('\t').join(tabReplace);
}

module.exports = { tabReplace, calls, render };
