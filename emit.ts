import { TSESTree } from "@typescript-eslint/typescript-estree";
import { generate } from "escodegen";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ComponentTree, traverseTreeLinear } from "./flow";
import { FileContext } from "./context";

export type EmitContext = {
  dTsPath: string;
  events: Array<Event>;
};

export type Event = {
  event: string;
  argumentRawType: string;
};

export function emitEventDeclarations(events: Array<Event>) {
  return events.map(({ event, argumentRawType: argument }) => {
    const type = argument ? argument : "unknown";

    return `declare function $on(event: "${event}", callback: (data: ${type}) => MaybePromise<void>)`;
  });
}

function emitConstantDeclarationsBufferLike() {
  return [
    "declare function $mutate(...variables: any[]): void",
    "declare function $watch<T>(variable: T, callback: (value: T) => MaybePromise<void>): void",
  ];
}

function emitDispatchDeclarations(events: Array<Event>) {
  return events.flatMap(({ event, argumentRawType: argument }) => {
    const type = argument ? argument : "unknown";

    return [
      `declare function $dispatchUp(event: "${event}", data: ${type}, options: {}): void`,
      `declare function $dispatchDown(event: "${event}", data: ${type}, options: {}): void`,
    ];
  });
}

function emitDollarDeclarations(context: EmitContext) {
  // path.join(context.dTsDirContainingPath, ".d.ts");
  return [
    ...emitEventDeclarations(context.events),
    ...emitDispatchDeclarations(context.events),
    ...emitConstantDeclarationsBufferLike(),
  ].join("\n");
}

function generatedWarning() {
  return `/*
  THIS FILE IS GENERATED AUTOMATICALLY, DO NOT EDIT

  this file provides typings for .ihi.tsx files
  when the .ihi.tsx files are compiled, this file is emitted
  if you do not see your type in here, make sure compiler is
  running in watch mode or you run it manually to populate
  this file.
*/`;
}

export function createContextFromTree(
  fileContext: FileContext,
  srcDir: string,
  tree: ComponentTree,
): EmitContext {
  const events = traverseTreeLinear(tree, ({ component }) =>
    component.componentDeclaration.eventCallbacks.map(
      (eventCallback) => {
        if (eventCallback.callbackArgument.params.length != 1) {
          return {
            event: eventCallback.eventName,
            argumentRawType: null
          };
        }

        if ("typeAnnotation" in eventCallback.callbackArgument.params[0] && eventCallback.callbackArgument.params[0].typeAnnotation !== undefined) {
          const argumentRawType = fileContext.readLoc(eventCallback.callbackArgument.params[0].typeAnnotation.typeAnnotation.loc);

          return {
            event: eventCallback.eventName,
            argumentRawType
          };
        }
      }
    ),
  );

  return {
    dTsPath: join(srcDir, ".d.ts"),
    events,
  };
}

export async function emitDeclarationsIntoFile(context: EmitContext) {
  await writeFile(context.dTsPath, generatedWarning());
  await writeFile(context.dTsPath, emitDollarDeclarations(context));
}
