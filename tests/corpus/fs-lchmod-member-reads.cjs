// fs.lchmod and fs.lchmodSync are exports that hold undefined where lchmod(2)
// does not exist (Node's lib/fs.js assigns them only on macOS), so reading the
// member as a value answers undefined, the property stays own/enumerable, and
// a call through the read value reports the not-a-function TypeError.
//
// The membership shape is the same on every platform: the key is assigned even
// where the value is undefined. On macOS Node exports the two functions, and a
// native read of either is a refusal (a Node value native code does not provide
// as a value), so the value and call lines below run where the exports hold
// undefined and the macOS lane pins the membership shape only.
const fs = require('fs');

console.log('in lchmod', 'lchmod' in fs, 'in lchmodSync', 'lchmodSync' in fs);
console.log('keys include', Object.keys(fs).includes('lchmod'), Object.keys(fs).includes('lchmodSync'));

if (process.platform !== 'darwin') {
  const show = (label, value) => console.log(label, typeof value, JSON.stringify(value));

  show('lchmod', fs.lchmod);
  show('lchmodSync', fs.lchmodSync);

  const stored = fs.lchmod;
  const storedSync = fs.lchmodSync;
  show('stored', stored);
  show('storedSync', storedSync);

  const attempt = (label, run) => {
    try {
      console.log(label, 'returned', run());
    } catch (error) {
      console.log(label, error.name, JSON.stringify(error.code), JSON.stringify(error.message));
    }
  };

  attempt('direct lchmod', () => fs.lchmod(__filename, 0o600, () => {}));
  attempt('direct lchmodSync', () => fs.lchmodSync(__filename, 0o600));
  attempt('stored lchmod', () => stored(__filename, 0o600, () => {}));
  attempt('stored lchmodSync', () => storedSync(__filename, 0o600));
  attempt('computed', () => fs['lchmod'](__filename, 0o600, () => {}));
}
