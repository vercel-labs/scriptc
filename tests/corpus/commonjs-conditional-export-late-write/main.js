import pick from './pick.cjs';
import one from './one.cjs';
import two from './two.cjs';

one.setMode('one-late');
console.log(pick.mode);
two.setMode('two-late');
console.log(pick.mode);
