'use strict';
const core = require('./core.js');
const more = require('./more.js');
const schemas = new Map([
  ['core', core.tags],
  ['more', more.tags]
]);
console.log(schemas.size);
console.log(schemas.get('core')[0].tag, schemas.get('more')[1].tag);
schemas.set('extra', [{ default: false, tag: 'extra' }]);
console.log([...schemas.keys()].join(','));
