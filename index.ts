import { command, positional, run } from "cmd-ts";
import { File } from "cmd-ts/batteries/fs";
import { readFile } from "node:fs/promises";
import process, { exit } from "node:process";
import { Component, parseRootComponent } from "./parse";
import { analyzeReactiveness, ComponentTree } from "./flow";
import { FileContext } from "./context";
import { createContextFromTree, emitDeclarationsIntoFile } from "./emit";
import { basename, dirname, join } from "node:path";

async function compile(
  path: string,
): Promise<(ComponentTree & { context: FileContext }) | null> {
  const parsedComponent = parseRootComponent(
    path,
    await readFile(path, { encoding: "utf8" }),
  );

  if (parsedComponent === undefined) return null;

  const children = await Promise.all(
    parsedComponent.component.imports
      .map((importDeclaration) => importDeclaration.source.value)
      .filter((path) => path.endsWith(".ihi") || path.endsWith(".ihi.ts"))
      .map(compile),
  );

  if (children.filter((x) => x === null).length > 0) return null;

  return {
    parent: {
      component: parsedComponent.component,
      path,
    },

    context: parsedComponent.context,

    children: children as ComponentTree[],
  };
}

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

    const tree = await compile(component);

    if (tree !== null) {
      analyzeReactiveness(tree.context, tree);

      await emitDeclarationsIntoFile(
        createContextFromTree(tree.context, dirname(component), tree),
      );
    }
  },
});

run(app, process.argv.slice(2));
