// A CommonJS module whose whole export is a single value is what
// `require()` answers, so every binding of it — a plain require() binding,
// an ES default import, a createRequire binding — IS that value, including
// the `var x = module.exports = <value>` declaration spelling and a module
// that re-exports another single-value module.
import chained from './chained.cjs';
import reexported from './reexport.cjs';
import settings from './factory.cjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const lifted = require('./chained.cjs');

console.log('A1', typeof chained, chained(21));
console.log('A2', chained.extra, chained.triple(3));
console.log('A3', chained.named, chained === lifted);
console.log('B1', typeof reexported, reexported({ a: 1 }, 'a').value);
console.log('B2', reexported.name);
console.log('C1', typeof lifted, lifted === chained, lifted(4));
console.log('D1', settings.mode, settings.turbo, Object.keys(settings).join(','));
