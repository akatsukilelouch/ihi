"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const cmd_ts_1 = require("cmd-ts");
const fs_1 = require("cmd-ts/batteries/fs");
const promises_1 = require("node:fs/promises");
const node_process_1 = __importDefault(require("node:process"));
const parse_1 = require("./parse");
const app = (0, cmd_ts_1.command)({
    name: "ihi",
    args: {
        component: (0, cmd_ts_1.positional)({
            type: fs_1.File,
            displayName: "component",
            description: "path to the component file",
        }),
    },
    handler: (_a) => __awaiter(void 0, [_a], void 0, function* ({ component }) {
        if (!component.endsWith(".ihi.tsx")) {
            console.warn(`file ${component} doesn't end with .ihi.tsx`);
            console.warn("this will be a hard error in future");
        }
        const contents = yield (0, promises_1.readFile)(component, { encoding: "utf8" });
        (0, parse_1.parseRootComponent)(contents);
    }),
});
(0, cmd_ts_1.run)(app, node_process_1.default.argv.slice(2));
