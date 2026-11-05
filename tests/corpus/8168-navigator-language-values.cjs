// @no-node-shims
// navigator.language, navigator.languages and navigator.platform read
// without the navigator object ever being taken as a value: the runtime
// caches the answers and releases them at exit.
"use strict";
console.log(typeof navigator.language, navigator.language.length > 0);
console.log(navigator.languages.length, navigator.languages[0] === navigator.language);
console.log(Object.isFrozen(navigator.languages), typeof navigator.platform);
