class Ledger {
  constructor(options) {
    this.name = options.name;
    this.sink = options.sink;
  }
  post(name, amount) {
    this.sink.record({ name, amount, tags: {} });
  }
}
module.exports = { Ledger };
