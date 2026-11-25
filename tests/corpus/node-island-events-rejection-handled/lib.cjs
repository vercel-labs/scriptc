"use strict";
const log = (s) => console.log(s);
exports.listen = () => {
  process.on("unhandledRejection", (reason) => log(`island unhandledRejection: ${reason.message}`));
  process.on("rejectionHandled", (promise) => log(`island rejectionHandled: ${promise instanceof Promise}`));
};
exports.rejected = (m) => Promise.reject(new Error(m));
exports.catchLater = (p, ms) => {
  setTimeout(() => p.catch((e) => log(`island late catch: ${e.message}`)), ms);
};
