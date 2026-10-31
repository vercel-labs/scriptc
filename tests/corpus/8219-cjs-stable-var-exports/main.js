// A var and a let exported by reference, where neither changes after the
// export: importers see the same instance and value as Node.
'use strict';

const hljs = require('./lib');
const core = require('./lib/core');
const options = require('./lib/options');

console.log(hljs === core, hljs.versionString);
console.log(hljs.listLanguages());
console.log(hljs.highlight('const x = function', 'javascript'));
hljs.registerLanguage('ruby', ['def', 'end']);
console.log(core.listLanguages().length, core.highlight('def run end', 'ruby'));
try {
  hljs.highlight('x', 'cobol');
} catch (error) {
  console.log(error.message);
}

console.log(JSON.stringify(options.tabReplace), options.render('a\tb'), options.render('\tc'));
console.log(options.calls);
