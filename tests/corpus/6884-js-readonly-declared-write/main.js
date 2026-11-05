/// <reference path="./env.d.ts" />
// A JavaScript entry writes a member its declarations mark readonly
// (TS2540, relaxed in JavaScript files): `readonly` is a type annotation,
// and the write behaves as it does in Node.
console.log('before', process.env.APP_STAGE)
process.env.APP_STAGE = 'production'
console.log('after', process.env.APP_STAGE, typeof process.env.APP_STAGE)
delete process.env.APP_STAGE
console.log('deleted', process.env.APP_STAGE)
