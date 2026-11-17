'use strict';
module.exports = class ProdThing {
  constructor(value) {
    this.value = value + 'p';
  }
  hello() {
    return 'prod:' + this.value;
  }
};
