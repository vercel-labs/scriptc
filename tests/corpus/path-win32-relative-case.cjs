'use strict';
// path.win32.relative compares paths case-insensitively with
// String.prototype.toLowerCase, including characters whose lowercase form
// changes length (İ) or encoding width (Ⱥ).
const path = require('path');

const cases = [
  ['c:\\i̇\\a\\İ', 'c:\\İ\\b\\İ\\test.txt'],
  ['c:\\İ\\a', 'c:\\i̇\\a\\b'],
  ['c:\\İ\\a\\b', 'c:\\i̇\\a'],
  ['c:\\İ', 'C:\\I'],
  ['c:\\Ⱥ\\x\\y', 'c:\\ⱥ\\x\\z'],
  ['c:\\Ⱥ\\x', 'C:\\ⱥ\\X\\Y\\Z'],
  ['C:\\ΣΑΣ\\a', 'c:\\σας\\b'],
  ['c:\\straße\\a', 'C:\\STRASSE\\a'],
  ['\\\\Server\\Share\\İ\\a', '\\\\server\\share\\i̇\\b'],
  ['c:\\a\\b', 'C:\\A\\B'],
  ['c:\\a\\🙂\\x', 'c:\\A\\🙂\\y'],
];
for (const [from, to] of cases) {
  console.log(JSON.stringify([from, to]), JSON.stringify(path.win32.relative(from, to)));
}
