"use strict";
const { label } = require("./util");
const settings = require("../settings.json");

exports.describe = (name) => `${label(name)} (${settings.mode})`;

exports.hasOptional = () => {
  try {
    require("./not-shipped.cjs");
    return true;
  } catch (error) {
    return error.code !== "MODULE_NOT_FOUND";
  }
};
