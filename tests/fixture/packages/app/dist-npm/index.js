"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.main = main;
const core_1 = require("../../core/dist-npm/index.js");
function main() {
    const config = { name: 'test', version: '1.0.0' };
    console.log((0, core_1.greet)(config.name));
}
//# sourceMappingURL=index.js.map