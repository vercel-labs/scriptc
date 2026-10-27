// Functions whose JSDoc makes parameters optional, stored through an
// untyped receiver (`C.prototype.m = function (...)` inside a helper
// that takes the constructor): the stored value takes any arity, and
// omitted arguments are undefined.
function install(C) {
  /**
   * @param {string} name
   * @param {number=} amount
   * @param {string[]=} tags
   */
  C.prototype.add = function (name, amount, tags) {
    const n = amount === undefined ? 1 : amount;
    this.log.push(`${name}:${n}${tags ? '|#' + tags.join(',') : ''}`);
    return this;
  };
  /**
   * @param {(x: number) => number} fn
   * @param {string=} label
   */
  C.prototype.time = function (fn, label) {
    const self = this;
    return (x) => {
      const result = fn(x);
      self.log.push(`${label || 'anon'}=${result}`);
      return result;
    };
  };
}

const Recorder = function () {
  this.log = [];
};
install(Recorder);
const r = new Recorder();
r.add('a').add('b', 2).add('c', 3, ['x:y']);
const timed = r.time((x) => x * 2, 'double');
console.log(timed(21));
console.log(r.time((x) => x + 1)(6));
console.log(r.log.join(' '));
