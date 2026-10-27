/* @types/node declares http_parser, v8, uv, zlib, ares and modules as
 * strings. A compiled binary provides only node and openssl, and Node 24
 * has no http_parser either, so those entries read undefined and compare
 * like it. Checks on the others print agreement between equality, typeof
 * and `in`, which holds whichever entries the running process has. */
const versions = process.versions;

console.log(process.versions.http_parser === undefined, process.versions['http_parser'] === undefined);
console.log(versions.http_parser == null, typeof versions.http_parser, versions.http_parser ?? 'none');
const parser = versions.http_parser;
console.log(parser === undefined ? 'no http_parser' : parser);
if (versions.http_parser) console.log('http_parser truthy');
else console.log('http_parser falsy');

console.log(
  (process.versions.v8 === undefined) === !('v8' in process.versions),
  (process.versions['uv'] !== undefined) === 'uv' in versions,
  (versions.zlib == null) === (typeof versions.zlib === 'undefined'),
  (versions.ares === undefined) === (typeof versions.ares !== 'string'),
);
const names = ['v8', 'uv', 'zlib', 'ares', 'modules', 'node', 'openssl'] as const;
for (const name of names) {
  const value = versions[name];
  const absent = value === undefined;
  console.log(
    name,
    absent === !(name in versions),
    absent === (typeof value === 'undefined'),
    ((value ?? '') === '') === absent,
  );
}
const v8 = versions.v8;
console.log(v8 === undefined || v8.length > 0);
console.log(typeof (versions.modules || 'fallback'));
console.log(typeof versions.node, versions.openssl !== undefined, versions.node === process.version.slice(1));
