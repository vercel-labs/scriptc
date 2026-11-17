// node:diagnostics_channel — the argument and dispatch audit: Node's
// validateChannelName errors for channel() and subscribe(), the false
// answers unsubscribe() and hasSubscribers() give for a name that is not a
// string, duplicate subscriber entries, publish's optional message,
// channel-member argument checks, a subscriber throw that does not stop the
// dispatch and arrives through uncaughtException on a later tick, and the
// tracingChannel collection form plus its handler/apply errors.
'use strict';
const dc = require('node:diagnostics_channel');
const show = (label, fn) => {
  try {
    const value = fn();
    console.log(label, '=> ok', JSON.stringify(value));
  } catch (error) {
    console.log(label, '=>', error.constructor.name, String(error.code), JSON.stringify(error.message));
  }
};

// channel()/subscribe() validate the name; unsubscribe/hasSubscribers answer
// false for anything that is not a string.
show('channel(5)', () => dc.channel(5).name);
show('channel(null)', () => dc.channel(null).name);
show('channel()', () => dc.channel().name);
show('subscribe(5, fn)', () => dc.subscribe(5, () => {}));
show('hasSubscribers(5)', () => dc.hasSubscribers(5));
show('hasSubscribers()', () => dc.hasSubscribers());
show('unsubscribe(5, fn)', () => dc.unsubscribe(5, () => {}));
show('unsubscribe("x", 5)', () => dc.unsubscribe('x', 5));

// Symbol names are channel names too: identity keys the registry, the
// subscriber's name argument is that symbol, and so is Channel.name.
const symbolName = Symbol('audit:symbol');
const symbolChannel = dc.channel(symbolName);
const symbolListener = (message, name) => console.log('symbol subscriber:', message, name === symbolName);
dc.subscribe(symbolName, symbolListener);
symbolChannel.publish('symbol payload');
show('symbol name read', () => symbolChannel.name === symbolName);
console.log('symbol subscribed:', dc.hasSubscribers(symbolName), '| unsubscribe:', dc.unsubscribe(symbolName, symbolListener), '| now:', dc.hasSubscribers(symbolName));
show('tracingChannel(symbol)', () => dc.tracingChannel(symbolName));

// Module-level subscribe creates a channel nothing has interned yet.
const freshSeen = [];
dc.subscribe('audit:fresh', (message) => freshSeen.push(message));
dc.channel('audit:fresh').publish('fresh');
console.log('fresh channel subscriber:', freshSeen.join(','));

// The module functions validate the name before anything else, including
// when no arguments are given at all.
show('subscribe()', () => dc.subscribe());
show('unsubscribe()', () => dc.unsubscribe());

// publish evaluates the receiver, then the message, then any surplus
// arguments, and only then calls the subscribers.
const publishOrder = [];
const ordered = dc.channel('audit:order');
ordered.subscribe((message) => publishOrder.push(`subscriber ${message.tag}`));
const orderReceiver = () => {
  publishOrder.push('receiver');
  return ordered;
};
const orderMessage = () => {
  publishOrder.push('message');
  return { tag: 'msg' };
};
const orderSurplus = () => {
  publishOrder.push('surplus');
  return 5;
};
orderReceiver().publish(orderMessage(), orderSurplus());
console.log(publishOrder.join(','));

// A surplus argument that is null or undefined has no effect to keep, but it
// is still an argument: publish must compile (a bare unit value is not a
// valid statement) and the ignored values change nothing, while the surplus
// arguments around them still evaluate in order.
const unitOrder = [];
const units = dc.channel('audit:units');
const unitSurplus = () => unitOrder.push('surplus');
units.publish('a', null);
units.publish('b', undefined, unitSurplus(), null, undefined);
console.log('unit surplus:', unitOrder.join(','), '| subscribers:', units.hasSubscribers);

// Duplicate entries are separate; one unsubscribe removes the first.
const ch = dc.channel('audit:dup');
const seen = [];
const same = (message) => seen.push(`same ${message}`);
ch.subscribe(same);
ch.subscribe(same);
ch.subscribe((message) => seen.push(`other ${message}`));
ch.publish('one');
console.log(seen.join(','));
console.log('unsubscribe same:', ch.unsubscribe(same), '| still subscribed:', ch.hasSubscribers);
ch.publish('two');
console.log(seen.join(','));
console.log('unsubscribe same again:', ch.unsubscribe(same), '| subscribed:', ch.hasSubscribers);

// publish with no message publishes undefined; the member checks are Node's.
const empty = dc.channel('audit:empty');
empty.subscribe((message) => console.log('empty message:', String(message)));
show('ch.publish()', () => empty.publish());
show('ch.subscribe()', () => empty.subscribe());
show('ch.unsubscribe()', () => empty.unsubscribe());
console.log('after member checks:', empty.hasSubscribers);

// A throwing subscriber does not stop the dispatch or leave publish: both
// subscribers run, publish returns, and the throw arrives as an uncaught
// exception on a later tick.
const boom = dc.channel('audit:throw');
const order = [];
boom.subscribe(() => {
  throw new Error('sub-boom');
});
boom.subscribe(() => order.push('second subscriber'));
process.on('uncaughtException', (error) => console.log('uncaught:', error.message));
boom.publish('payload');
order.push('publish returned');
console.log(order.join(','));

// tracingChannel: the collection form over stored channels and the handler
// checks the per-event channels apply.
const collection = {
  start: dc.channel('audit:c:start'),
  end: dc.channel('audit:c:end'),
  asyncStart: dc.channel('audit:c:asyncStart'),
  asyncEnd: dc.channel('audit:c:asyncEnd'),
  error: dc.channel('audit:c:error'),
};
const tracing = dc.tracingChannel(collection);
console.log('collection:', tracing.start.name, tracing.end.name, tracing.error.name);
show('tracingChannel(5)', () => dc.tracingChannel(5));
show('tc.subscribe()', () => tracing.subscribe());
show('tc.subscribe({start: 5})', () => tracing.subscribe({ start: 5 }));
show('tc.unsubscribe({start: 5})', () => tracing.unsubscribe({ start: 5 }));
show('tc.traceSync(5)', () => tracing.traceSync(5));

// The named form still traces; its ticks are ordered by the immediate below.
const named = dc.tracingChannel('audit:named');
const events = [];
named.subscribe({
  start: (message) => events.push(`start ${message.step}`),
  end: (message) => events.push(`end ${message.step} result=${message.result}`),
});
const returned = named.traceSync(() => 41 + 1, { step: 'one' });
console.log('traceSync:', returned, '|', events.join(' '));
setImmediate(() => console.log('immediates run'));

// A collection with an absent member is refused before any handle exists:
// the missing event reads as undefined, which the collection check refuses
// (later reads must never see an invalid handle for it).
const absentEvents = dc.channel('audit:absent');
const partialChannels = {
  start: absentEvents,
  end: absentEvents,
  asyncStart: absentEvents,
  asyncEnd: absentEvents,
};
try {
  dc.tracingChannel(partialChannels);
  console.log('absent member accepted');
} catch (error) {
  console.log('absent member refused:', error.constructor.name, error.code, error.message);
}
