'use strict';
const map = {
    collection: 'map',
    default: true,
    nodeClass: null,
    tag: 'tag:yaml.org,2002:map',
    resolve(value, onError) {
        if (value === undefined) onError('Expected a mapping');
        return value;
    },
    createNode: (schema, obj, ctx) => obj
};
exports.map = map;
