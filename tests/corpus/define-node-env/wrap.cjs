"use strict";

if (process.env.NODE_ENV === "development") {
  module.exports = require("./missing.development.cjs");
} else if (!(process.env.NODE_ENV !== "production") || process.env.SCRIPTC_UNSET_FLAG === "1") {
  module.exports = require("./local.production.cjs");
} else {
  module.exports = require("./missing.other.cjs");
}
