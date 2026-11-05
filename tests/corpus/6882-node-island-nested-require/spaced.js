'use strict'
// This file spells its one require() call with a comment before the
// parenthesis.
exports.viaSpaced = (name) => require /* lazily */ ('spacedkit').wave(name)
