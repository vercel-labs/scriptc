// highlight.js's lib/core.js shape: the module builds one instance and
// exports the var that holds it.
'use strict';

const HLJS = function (options) {
  const languages = new Map();
  const prefix = options.classPrefix || 'hljs-';

  function registerLanguage(name, keywords) {
    languages.set(name, keywords);
  }

  function listLanguages() {
    return Array.from(languages.keys());
  }

  function highlight(code, name) {
    const keywords = languages.get(name);
    if (keywords === undefined) throw new Error(`Unknown language: "${name}"`);
    return code
      .split(' ')
      .map((word) => (keywords.includes(word) ? `<span class="${prefix}keyword">${word}</span>` : word))
      .join(' ');
  }

  return { registerLanguage, listLanguages, highlight, versionString: '10.7.3' };
};

var highlight = HLJS({});

module.exports = highlight;
