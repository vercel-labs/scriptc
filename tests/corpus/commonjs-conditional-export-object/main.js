import lib from './index.cjs';
import prod from './index-always-prod.cjs';

console.log(lib.mode, lib.pick());
console.log(prod.mode, prod.pick());
