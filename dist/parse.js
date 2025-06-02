"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseRootComponent = parseRootComponent;
const typescript_estree_1 = require("@typescript-eslint/typescript-estree");
function reportError(context, token, error) {
    console.error(`${context.file}:${token.loc.start}${token.loc.end}::\n\t${error}`);
}
function extractImportTableAndFunctionComponent(context, program) {
    for (const statement of program.body) {
        switch (statement.type) {
            case typescript_estree_1.AST_NODE_TYPES.ImportDeclaration:
                console.dir(statement);
                break;
            default:
                reportError(context, statement, "only import declaration is allowed");
                break;
        }
    }
}
function parseRootComponent(file, buffer) {
    const context = {
        file,
    };
    const program = (0, typescript_estree_1.parse)(buffer);
    extractImportTableAndFunctionComponent(context, program);
}
