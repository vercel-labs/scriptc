import full from './index-full.cjs';
import lean from './index-lean.cjs';

console.log(full.name, full.pick(), full.extra);
console.log(lean.name, lean.pick(), lean.extra);
console.log(typeof lean.extra);
