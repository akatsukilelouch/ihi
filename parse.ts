import {
  AST,
  AST_NODE_TYPES,
  parse,
  TSError,
  TSESTree,
  TSESTreeOptions,
} from "@typescript-eslint/typescript-estree";
import { FileContext, createFileContext } from "./context";

type Program = AST<TSESTreeOptions>;

type EventCallback = {
  eventName: string;
  callbackArgument:
    | TSESTree.FunctionExpression
    | TSESTree.ArrowFunctionExpression;
};

export function parseMagicFunctionExpression(
  context: FileContext,
  expression: TSESTree.CallExpression,
) {
  if (expression.callee.type !== AST_NODE_TYPES.Identifier) {
    context.pushError(
      expression.loc,
      'invalid callee, this must be of the form $name("event", () => { ... })',
    );
    return null;
  }

  if (!expression.callee.name.startsWith("$")) {
    context.pushError(
      expression.callee.loc,
      "magic function name must start with $",
    );
    context.pushNote("in this context a magic function is expected");
    return null;
  }

  return {
    name: expression.callee.name.slice(1), // without @
    expression,
  };
}

function isEventCallbackValid(
  context: FileContext,
  eventCallbackAst:
    | TSESTree.FunctionExpression
    | TSESTree.ArrowFunctionExpression,
) {
  if (eventCallbackAst.params.length > 1) {
    context.pushError(
      eventCallbackAst.params[1].loc,
      eventCallbackAst.params.length > 2 ? "extra arguments" : "extra argument",
    );
    return false;
  }

  return true;
}

function parseEventCallback(
  context: FileContext,
  statement: TSESTree.ExpressionStatement,
): EventCallback | null {
  if (statement.expression.type !== AST_NODE_TYPES.CallExpression) {
    context.pushError(
      statement.expression.loc,
      'not a call expression, this must be of the form $on("event", () => { ... })',
    );
    return null;
  }

  const magicFunction = parseMagicFunctionExpression(
    context,
    statement.expression,
  );

  if (magicFunction === null) {
    context.pushNote("expected an $on magic function call");
    return null;
  }

  if (magicFunction.name !== "on") {
    context.pushError(
      magicFunction.expression.callee.loc,
      "only $on event subscriber call is allowed here",
    );
    return null;
  }

  if (magicFunction.expression.arguments.length !== 2) {
    context.pushError(
      magicFunction.expression.arguments.length > 0
        ? statement.expression.arguments[0].loc
        : statement.loc,
      "there must be two arguments for the $on function, event name and a callback",
    );
    return null;
  }

  if (magicFunction.expression.typeArguments !== undefined) {
    context.pushError(
      magicFunction.expression.typeArguments.loc,
      "type arguments for callbacks are unsupported (and not required)",
    );
    return null;
  }

  const eventName = magicFunction.expression.arguments[0];
  const callbackAst = magicFunction.expression.arguments[1];

  if (eventName.type !== AST_NODE_TYPES.Literal) {
    context.pushError(eventName.loc, "event name must be a literal");
    return null;
  }

  if (
    callbackAst.type !== AST_NODE_TYPES.ArrowFunctionExpression &&
    callbackAst.type !== AST_NODE_TYPES.FunctionExpression
  ) {
    context.pushError(callbackAst.loc, "event callback must be a function");

    if (callbackAst.type === AST_NODE_TYPES.Identifier) {
      context.pushNote(
        "external event callbacks will need inadequate alterations to typescript lsp or too many .d.ts code",
      );
    }

    return null;
  }

  if (!isEventCallbackValid(context, callbackAst)) {
    context.pushError(statement.loc, "event callback is invalid");
    return null;
  }

  return {
    eventName: eventName.value!.toString(),
    callbackArgument: callbackAst,
  };
}

function parseComponentDeclaration(
  context: FileContext,
  func: TSESTree.FunctionDeclaration,
) {
  if (func.generator || func.async) {
    context.pushError(
      func.loc,
      "function can't be a generator or an async function",
    );
    return null;
  } else if (func.declare) {
    context.pushError(
      func.loc,
      "function can't be a declaration since there will be nothing to compile from",
    );
    return null;
  }

  let params: (TSESTree.TSParameterProperty | TSESTree.Identifier)[] = [];

  // Process function parameters
  for (const param of func.params) {
    switch (param.type) {
      case AST_NODE_TYPES.TSParameterProperty:
      case AST_NODE_TYPES.Identifier:
        params.push(param);
        break;
      default:
        context.pushError(
          param.loc,
          "only simple identifier parameters are allowed",
        );
        return null;
    }
  }

  let jsxReturn: TSESTree.JSXFragment | TSESTree.JSXElement | null = null;
  let reactiveProperties: {
    name: string;
    declarator: TSESTree.VariableDeclarator;
  }[] = [];
  let eventCallbacks: EventCallback[] = [];
  let localFunctionDeclarations: TSESTree.FunctionDeclaration[] = [];

  for (const statement of func.body.body) {
    switch (statement.type) {
      case AST_NODE_TYPES.FunctionDeclaration: {
        localFunctionDeclarations.push(statement);
        break;
      }

      // function calls with $ prefix are event callback subscribers
      case AST_NODE_TYPES.ExpressionStatement: {
        const eventCallback = parseEventCallback(context, statement);

        if (eventCallback === null) {
          context.pushError(statement.loc, "event callback is improper");
          return null;
        }

        eventCallbacks.push(eventCallback);
        break;
      }

      // Allow let declarations with $ prefix
      case AST_NODE_TYPES.VariableDeclaration: {
        if (statement.kind !== "let") {
          context.pushError(statement.loc, "only let declarations are allowed");
          return null;
        }

        for (const declarator of statement.declarations) {
          if (
            declarator.id.type === AST_NODE_TYPES.Identifier &&
            declarator.id.name.startsWith("$") &&
            declarator.id.name.length > 1
          ) {
            reactiveProperties.push({
              name: declarator.id.name.slice(1),
              declarator,
            });
          } else {
            context.pushError(
              statement.loc,
              "variable identifiers must start with '$'",
            );
            return null;
          }
        }
        break;
      }

      // Check return statement for JSX
      case AST_NODE_TYPES.ReturnStatement: {
        if (statement.argument === null) {
          context.pushError(
            statement.loc,
            "return statement must return a JSX component",
          );
          return null;
        }

        if (
          statement.argument.type === AST_NODE_TYPES.JSXElement ||
          statement.argument.type === AST_NODE_TYPES.JSXFragment
        ) {
          jsxReturn = statement.argument;
        } else {
          context.pushError(
            statement.loc,
            "return statement must return a JSX component",
          );
          context.pushNote(
            "calling functions to return jsx components is not yet supported",
          );
          return null;
        }

        break;
      }

      default:
        context.pushError(
          statement.loc,
          "disallowed statement type in function body",
        );

        return null;
    }
  }

  if (jsxReturn === null) {
    context.pushError(func.loc, "no jsx return in the component");
    return null;
  }

  return {
    jsxReturn,
    eventCallbacks,
    reactiveProperties,
    localFunctionDeclarations,
  };
}

function analyzeComponent(context: FileContext, program: Program) {
  let defaultExport: TSESTree.ExportDefaultDeclaration | null = null;
  let imports: TSESTree.ImportDeclaration[] = [];
  let typescriptDeclarations: (
    | TSESTree.TSEnumDeclaration
    | TSESTree.TSTypeAliasDeclaration
    | TSESTree.TSDeclareFunction
    | TSESTree.TSInterfaceDeclaration
    | TSESTree.TSModuleDeclaration
  )[] = [];

  let globalFunctionDeclarations: TSESTree.FunctionDeclaration[] = [];

  for (const statement of program.body) {
    switch (statement.type) {
      case AST_NODE_TYPES.TSDeclareFunction:
      case AST_NODE_TYPES.TSEnumDeclaration:
      case AST_NODE_TYPES.TSInterfaceDeclaration:
      case AST_NODE_TYPES.TSModuleDeclaration:
      case AST_NODE_TYPES.TSTypeAliasDeclaration:
        typescriptDeclarations.push(statement);
        break;

      case AST_NODE_TYPES.FunctionDeclaration:
        globalFunctionDeclarations.push(statement);
        break;

      case AST_NODE_TYPES.ImportDeclaration:
        imports.push(statement);
        break;
      case AST_NODE_TYPES.ExportDefaultDeclaration:
        if (defaultExport !== null) {
          context.pushError(
            statement.loc,
            "there must be only one default export",
          );
          return;
        }

        defaultExport = statement;
        break;
      default:
        context.pushError(
          statement.loc,
          "only import declarations or a single default function export declaration are allowed",
        );
        return;
    }
  }

  if (defaultExport === null) {
    context.pushError(program.loc, "no default function export found");
    return;
  } else if (
    defaultExport.declaration.type !== AST_NODE_TYPES.FunctionDeclaration
  ) {
    context.pushError(program.loc, "default export is not a function export");
    return;
  }

  const componentDeclaration = parseComponentDeclaration(
    context,
    defaultExport.declaration,
  );

  if (componentDeclaration === null) {
    context.pushError(defaultExport.loc, "component declaration is invalid");
    context.reportErrors();
    return;
  }

  return {
    componentDeclaration,
    globalFunctionDeclarations,
    typescriptDeclarations,
    imports,
  };
}

export function parseRootComponent(file: string, buffer: string) {
  const context = createFileContext(file, buffer);

  let program: Program;
  try {
    program = parse(buffer, {
      loc: true,
      jsx: true,
    });
  } catch (error) {
    if (error instanceof TSError) {
      context.pushError(error.location, error.message);
      context.reportErrors();

      return;
    } else {
      throw error;
    }
  }

  const component = analyzeComponent(context, program);
  if (component === undefined) {
    console.error(`failed parsing ${file}`);

    return;
  }

  return {
    component,
    context,
  };
}

export type Component = NonNullable<
  ReturnType<typeof parseRootComponent>
>["component"];
