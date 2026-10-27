class Registry {
  constructor() {
    this.items = [];
  }
  add(item) {
    this.items.push(item);
    return this.items.length;
  }
  size() {
    return this.items.length;
  }
}
module.exports = new Registry();
