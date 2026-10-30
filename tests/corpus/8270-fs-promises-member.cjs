'use strict';
// fs.promises is node:fs/promises, as in Node: through a binding, an
// inline require, destructuring and a direct member call.
const fs = require('fs');
const path = require('path');
const os = require('os');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptc-fsp-'));
const file = path.join(dir, 'data.txt');
const fsPromises = fs.promises;
const { readFile, stat } = require('fs').promises;
const { open } = fs.promises;

(async () => {
  await fsPromises.writeFile(file, 'abc');
  await fs.promises.appendFile(file, 'def');
  console.log(await readFile(file, 'utf8'));
  console.log((await stat(file)).size);
  const handle = await open(file, 'r');
  const { bytesRead, buffer } = await handle.read(Buffer.alloc(3), 0, 3, 1);
  console.log(bytesRead, buffer.toString());
  await handle.close();
  await fsPromises.rm(dir, { recursive: true });
  console.log(fs.existsSync(dir));
})();
