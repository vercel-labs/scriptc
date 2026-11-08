"use strict";
exports.install = () =>
  process.on("uncaughtException", (e) => {
    console.log(`island listener: ${e.message}`);
    throw new Error("the listener failed");
  });
