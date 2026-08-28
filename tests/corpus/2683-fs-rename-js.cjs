// checkJs callback parameters cross through the dyn Error/null adapter.
const fs = require('fs');
const path = require('path');
const os = require('os');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scr-rename-js-'));
const from = path.join(dir, 'from.txt');
const to = path.join(dir, 'to.txt');
const missing = path.join(dir, 'missing.txt');
const other = path.join(dir, 'other.txt');
fs.writeFileSync(from, 'js');

// Stored before it enters the callback slot, so its parameter retains the
// checkJs `any`/dyn shape and exercises the dynamic Error adapter.
const onMissing = (missingErr) => {
  console.log('js callback error:', missingErr.code, missingErr.message.includes('rename'));
  fs.rmSync(dir, { recursive: true, force: true });
  return missingErr !== null; // Node ignores callback results.
};

fs.rename(from, to, (err) => {
  console.log('js callback:', err === null, fs.readFileSync(to, 'utf8'));
  fs.rename(missing, other, onMissing);
});
