'use strict';

const Common = require('./common');
const Cors = require('./cors');

const internals = {};

internals.root = function () {

    return { tag: 'root', check: Common.check, cors: Cors.apply };
};

module.exports = internals.root();
