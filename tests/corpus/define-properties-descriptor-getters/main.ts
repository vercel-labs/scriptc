// Getters on a descriptor and on the map of Object.defineProperties: the fields are read in
// ToPropertyDescriptor order, and an exception from one arrives before any property is defined.
import "./error-order.ts";
import "./descriptor-getter-fields.ts";
