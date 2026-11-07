// A non-computed `__proto__` member of an exports table literal sets the
// exports object's prototype as the literal is built (B.3.1); it is not an
// export name of its own.
module.exports = { __proto__: null, answer: 42 };
