"use strict";
exports.listen = () => process.on("uncaughtException", (e) => console.log(`island saw ${e.message}`));
