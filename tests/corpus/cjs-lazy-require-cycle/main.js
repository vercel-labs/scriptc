// A CommonJS cycle that closes through a function-scoped require: the lazy
// require lowers to its target's guarded init at the call site, so the target
// initializes after its requirer's top level and its own top-level require of
// the requirer is a cache hit. The emission-order walk must admit the same
// edge rather than treat it as an eager cycle.
'use strict';

const Joi = require('./index');

console.log(Joi.tag, Joi.check(), Joi.check());
console.log(Joi.cors(), Joi.cors());
