'use strict';
const seq = {
    collection: 'seq',
    default: true,
    nodeClass: null,
    tag: 'tag:yaml.org,2002:seq',
    resolve(value, onError) {
        if (!Array.isArray(value)) onError('Expected a sequence');
        return value;
    }
};
exports.seq = seq;
