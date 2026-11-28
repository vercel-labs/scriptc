// STATIC symbol-keyed class members (`static [Symbol.for(name)] = v` and
// `static [kSerialize]() {}`): the kind @workflow's serialization protocol
// declares on model classes. The keys are module-level symbol constants
// whose descriptions are folded (template literals over constants), the
// members live on the class value (one storage for every instance), and a
// subclass reads them through its own name.
'use strict';

const { inspect } = require('util');

const registryName = 'workflow.serialize';
const kSerialize = Symbol.for(registryName);
const kModelId = Symbol(`workflow.${'model'}.id`);
const kTag = Symbol('workflow' + '-tag');

class Model {
  constructor(id) {
    this.id = id;
  }

  static [kSerialize](model) {
    return { id: model.id, via: Symbol.keyFor(kSerialize) };
  }

  static [kModelId] = 'model-id';
  static [kTag] = 'tag';
}

class Refined extends Model {}

const model = new Model('m1');
console.log('method:', typeof Model[kSerialize], Model[kSerialize](model));
console.log('field:', Model[kModelId], Model[kTag]);
console.log('inherited:', Refined[kModelId], typeof Refined[kSerialize]);
console.log('call through subclass:', Refined[kSerialize](new Refined('r2')));
console.log('instance is untouched:', Object.keys(model), kModelId in model);

class Leaf {
  static [kTag] = 7;
}
console.log('standalone:', Leaf[kTag], inspect(Leaf[kTag]));
