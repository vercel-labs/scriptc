// The descriptor map of Object.defineProperties and Object.create: data and accessor descriptors,
// symbol and computed keys, a map held in a variable (inferred, declared, built key by key), a
// getter on the map, keys the map does not own or enumerate, key order, the order of errors (every
// descriptor is read and converted before any property is defined), maps that are not objects.
import "./data-attributes.ts";
import "./accessors.ts";
import "./symbol-keys.ts";
import "./computed-keys.ts";
import "./map-variable.ts";
import "./map-getter.ts";
import "./map-getter-variable.ts";
import "./map-function.ts";
import "./map-skips-non-enumerable-and-inherited.ts";
import "./invalid-mixed-descriptor.ts";
import "./descriptor-not-object.ts";
import "./getter-not-function.ts";
import "./key-order.ts";
import "./map-null-undefined-primitive.ts";
import "./descriptor-class-instance.ts";
import "./descriptor-variables-and-identity.ts";
import "./map-dynamic-sources.ts";
import "./redefine-existing.ts";
import "./view-receiver-map-forms.ts";
import "./reflect-and-statics-on-result.ts";
import "./map-variable-declared-type.ts";
import "./map-variable-record-of-descriptors.ts";
import "./object-create-with-map.ts";
