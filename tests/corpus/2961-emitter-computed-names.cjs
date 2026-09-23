const { EventEmitter } = require('node:events');

const emitter = new EventEmitter();
let key = 'alpha';
const listener = (value) => console.log('value', String(value));

emitter.on(`topic:${key}`, listener);
emitter.once(`topic:${key}`, () => console.log('once'));
console.log('count', emitter.listenerCount(`topic:${key}`, listener));
console.log('had', emitter.emit(`topic:${key}`, 'first'));
console.log('had', emitter.emit(`topic:${key}`));
emitter.off(`topic:${key}`, listener);
console.log('had', emitter.emit(`topic:${key}`, 'third'));
console.log('names', emitter.eventNames().join(','));

let position = 'after';
emitter.on(`${position}Help`, (value) => console.log('suffix', String(value)));
console.log('help', emitter.emit('afterHelp', 'body'));
position = 'before';
emitter.on('beforeHelp', (value) => console.log('literal', String(value)));
console.log('help', emitter.emit(`${position}Help`, 'other'));
