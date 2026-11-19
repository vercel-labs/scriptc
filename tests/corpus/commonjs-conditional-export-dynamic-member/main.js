import full from './index-full.cjs';
import lean from './index-lean.cjs';

console.log(full.name, JSON.stringify(full.data), typeof full.mix);
console.log(lean.name, lean.data === undefined, lean.mix === undefined);
