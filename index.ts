import { command, positional, run } from "cmd-ts";
import { File } from "cmd-ts/batteries/fs";
import { readFile } from "node:fs/promises";
import process, { exit } from "node:process";
import { parseRootComponent } from "./parse";

const app = command({
  name: "ihi",
  args: {
    component: positional({
      type: File,
      displayName: "component",
      description: "path to the component file",
    }),
  },
  handler: async ({ component }) => {
    if (!component.endsWith(".ihi.tsx")) {
      console.warn(`file ${component} doesn't end with .ihi.tsx`);
      console.warn("this will be a hard error in future");
    }
    const contents = await readFile(component, { encoding: "utf8" });
    parseRootComponent(component, contents);
  },
});

run(app, process.argv.slice(2));
