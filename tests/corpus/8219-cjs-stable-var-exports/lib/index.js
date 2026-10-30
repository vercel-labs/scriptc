// highlight.js's lib/index.js shape: require the core instance, register
// languages on it and export the same var.
var hljs = require('./core');

hljs.registerLanguage('javascript', ['const', 'let', 'function', 'return']);
hljs.registerLanguage('python', ['def', 'return', 'lambda']);

module.exports = hljs;
