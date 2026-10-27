// @ts-nocheck
// JSDoc in a file TypeScript does not check documents the usual types of
// functions stored on a prototype without constraining their callers:
// undefined, objects and numbers reach parameters documented otherwise.
const Client = function (rate) {
  this.sampleRate = rate || 1;
  this.prefix = 'p.';
};

/**
 * Sends a stat.
 * @param stat {String} The stat
 * @param value The value
 * @param type {String} The type
 * @param sampleRate {Number} The rate
 * @param tags {Array} The tags
 * @param callback {Function=} Called after sending
 */
Client.prototype.sendStat = function (stat, value, type, sampleRate, tags, callback) {
  let message = `${this.prefix + stat}:${value}|${type}`;
  sampleRate = sampleRate || this.sampleRate;
  if (sampleRate && sampleRate < 1) {
    message += `|@${sampleRate}`;
  }
  console.log(message, Array.isArray(tags) ? tags.join(',') : String(tags));
  if (callback) callback();
};

/**
 * @param stat {String} The stat
 * @param value {Number} The value
 */
Client.prototype.count = function (stat, value) {
  this.sendStat(stat, value === undefined ? 1 : value, 'c');
};

const c = new Client();
c.sendStat('a', 1, 'c', undefined, undefined);
c.sendStat('b', 2, 'g', 0.5, { k: 'v' }, () => console.log('callback'));
c.sendStat(7, '3', 'ms', '0.25', ['x', 'y']);
new Client(0.25).sendStat('c', 3, 'ms');
c.count('hits');
c.count('more', 'five');
