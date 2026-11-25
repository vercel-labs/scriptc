'use strict';
module.exports = class DevThing {
  constructor(value) {
    this.value = value + 'd';
  }
  hello() {
    return 'dev:' + this.value;
  }
};
