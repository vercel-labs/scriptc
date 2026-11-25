"use strict";
exports.summary = (table) =>
  `${typeof table} ${Object.keys(table).join(",")} ${JSON.stringify(Object.entries(table))}`;
exports.names = (table) => Object.getOwnPropertyNames(table).filter((key) => isNaN(key));
