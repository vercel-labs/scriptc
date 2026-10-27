// An ES module's top-level `let x;` bindings that an exported function
// can reach before their declarations run. Only an access that really
// happens before the declaration throws; after the module body ran,
// calls see the bindings (undefined until assigned).
import { cliui, early } from './lib.js';

console.log(early);
console.log(cliui({ width: 3 }), cliui(undefined));
