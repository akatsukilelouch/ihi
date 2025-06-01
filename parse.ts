import {
  AST,
  AST_NODE_TYPES,
  createProgram,
  parse,
  TSError,
  TSESTree,
  TSESTreeOptions,
} from "@typescript-eslint/typescript-estree";
import { closest, distance } from "fastest-levenshtein";
import { CallExpression, VariableDeclaration } from "typescript";

type Program = AST<TSESTreeOptions>;

function createReportContext(file: string, buffer: string) {
  let errorStack: {
    text: string;
    notes: string[];
  }[] = [];

  return {
    file,
    lines: buffer.split("\n"),

    getLineContext(location: TSESTree.SourceLocation, context: number = 2) {
      let lowerBound = location.start.line - 1 - context;
      if (lowerBound < 0) lowerBound = 0;

      let upperBound = location.end.line + context;
      if (upperBound >= this.lines.length) upperBound = this.lines.length;

      let lines: { line: number; highlight?: number; text: string }[] = [];

      for (let i = lowerBound; i < upperBound; ++i) {
        const highlight = i == location.start.line - 1;

        lines.push({
          line: i + 1,
          highlight: highlight ? location.start.column : undefined,
          text: this.lines[i],
        });
      }

      return lines;
    },

    pushError(location: TSESTree.SourceLocation, error: any) {
      const report = String(error);
      // report = report[0].toUpperCase() + report.slice(1) + ".";

      const lineContext = this.getLineContext(location);
      const lineMaximum = lineContext.reduce(
        (a, { line }) => (a < line ? line : a),
        0,
      );

      const padding = lineMaximum.toString().length;

      const context = lineContext
        .flatMap(({ line, highlight, text }) => {
          const leftPart = `| ${line.toString().padStart(padding)} | `;

          if (highlight) {
            let selector = "";
            for (let i = 0; i < highlight + leftPart.length; ++i) {
              selector += " ";
            }

            selector += "^ - " + report;

            return [leftPart + text, selector];
          } else {
            return [leftPart + text];
          }
        })
        .join("\n    ");

      errorStack.push({
        text: `${this.file}:${location.start.line}:${location.start.column + 1}:\n    ${context}`,
        notes: [],
      });
    },

    pushNote(note: string) {
      errorStack[errorStack.length - 1].notes.push("\n    note: " + note);
    },

    discardErrors() {
      errorStack = [];
    },

    reportErrors() {
      if (errorStack.length > 0) {
        errorStack.reverse();

        const { text, notes } = errorStack[0];
        console.error(text);
        for (const note of notes) {
          console.error(note);
        }

        if (errorStack.length > 1) {
          console.error("caused by...");

          for (let i = 1; i < errorStack.length; ++i) {
            const { text, notes } = errorStack[i];

            console.error(
              text
                .split("\n")
                .map((v) => "  " + v)
                .join("\n"),
            );
            for (const note of notes) {
              console.error(
                note
                  .split("\n")
                  .map((v) => "  " + v)
                  .join("\n"),
              );
            }

            if (i !== errorStack.length - 1) console.error("  caused by...");
          }
        }

        errorStack = [];

        return true;
      } else {
        return false;
      }
    },
  };
}

type ComponentReportContext = ReturnType<typeof createReportContext>;

type EventCallback = {
  eventName: string;
  callbackArgument:
    | TSESTree.FunctionExpression
    | TSESTree.ArrowFunctionExpression;
};

function parseMagicFunctionExpression(
  context: ComponentReportContext,
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
  context: ComponentReportContext,
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
  context: ComponentReportContext,
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
    eventName: eventName.raw,
    callbackArgument: callbackAst,
  };
}

function parseComponentDeclaration(
  context: ComponentReportContext,
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

function traverseAndFindMutates(
  context: ComponentReportContext,
  node: TSESTree.Node,
  fail: () => void,
  callback: (node: TSESTree.CallExpression) => void,
): void {
  // First check if this node is an assignment expression
  if (node.type === AST_NODE_TYPES.CallExpression) {
    const magicFunction = parseMagicFunctionExpression(context, node);

    if (magicFunction === null) {
      context.discardErrors();
    } else {
      if (magicFunction.name !== "mutate") {
        context.pushError(
          magicFunction.expression.loc,
          "there is only one possible magic function to call, and it is $mutate",
        );
        context.reportErrors();
        return fail();
      }

      if (magicFunction.expression.arguments.length !== 1) {
        context.pushError(
          magicFunction.expression.loc,
          "magic function call @mutate shall take a reactive variable in",
        );
        context.reportErrors();
        return fail();
      }

      const targetVariable = magicFunction.expression.arguments[0];
      if (targetVariable.type !== AST_NODE_TYPES.Identifier) {
        context.pushError(
          targetVariable.loc,
          "magic function call @mutate shall take a reactive variable",
        );

        if (
          targetVariable.type === AST_NODE_TYPES.Literal &&
          targetVariable.raw.startsWith('"$')
        ) {
          context.pushNote(
            `you probably meant property ${targetVariable.value as string} instead of a literal ${targetVariable.raw}`,
          );
        }

        context.reportErrors();
        return fail();
      }

      return callback(magicFunction.expression);
    }
  }

  // traverse all possible children that could contain @mutate(#variable)
  switch (node.type) {
    case AST_NODE_TYPES.ExpressionStatement:
      traverseAndFindMutates(context, node.expression, fail, callback);
      break;
    case AST_NODE_TYPES.BlockStatement:
      node.body.forEach((stmt) =>
        traverseAndFindMutates(context, stmt, fail, callback),
      );
      break;
    case AST_NODE_TYPES.IfStatement:
      traverseAndFindMutates(context, node.test, fail, callback);
      traverseAndFindMutates(context, node.consequent, fail, callback);
      if (node.alternate)
        traverseAndFindMutates(context, node.alternate, fail, callback);
      break;
    case AST_NODE_TYPES.WhileStatement:
    case AST_NODE_TYPES.DoWhileStatement:
      traverseAndFindMutates(context, node.test, fail, callback);
      traverseAndFindMutates(context, node.body, fail, callback);
      break;
    case AST_NODE_TYPES.ForStatement:
      if (node.init) traverseAndFindMutates(context, node.init, fail, callback);
      if (node.test) traverseAndFindMutates(context, node.test, fail, callback);
      if (node.update)
        traverseAndFindMutates(context, node.update, fail, callback);
      traverseAndFindMutates(context, node.body, fail, callback);
      break;
    case AST_NODE_TYPES.ForInStatement:
    case AST_NODE_TYPES.ForOfStatement:
      traverseAndFindMutates(context, node.right, fail, callback);
      traverseAndFindMutates(context, node.left, fail, callback);
      traverseAndFindMutates(context, node.body, fail, callback);
      break;

    // Other containers
    case AST_NODE_TYPES.SwitchStatement:
      traverseAndFindMutates(context, node.discriminant, fail, callback);
      node.cases.forEach((c) => {
        if (c.test !== null)
          traverseAndFindMutates(context, c.test, fail, callback);

        c.consequent.forEach((stmt) =>
          traverseAndFindMutates(context, stmt, fail, callback),
        );
      });
      break;

    case AST_NODE_TYPES.ReturnStatement:
      if (node.argument)
        traverseAndFindMutates(context, node.argument, fail, callback);
      break;

    // Expression containers
    case AST_NODE_TYPES.ArrayExpression:
      node.elements.forEach((element) => {
        if (element !== null)
          traverseAndFindMutates(context, element, fail, callback);
      });
      break;
    case AST_NODE_TYPES.ObjectExpression:
      node.properties.forEach((prop) =>
        traverseAndFindMutates(context, prop, fail, callback),
      );
      break;
    case AST_NODE_TYPES.SequenceExpression:
      node.expressions.forEach((expr) =>
        traverseAndFindMutates(context, expr, fail, callback),
      );
      break;
    case AST_NODE_TYPES.ConditionalExpression:
      traverseAndFindMutates(context, node.test, fail, callback);
      traverseAndFindMutates(context, node.consequent, fail, callback);
      traverseAndFindMutates(context, node.alternate, fail, callback);
      break;
    case AST_NODE_TYPES.LogicalExpression:
    case AST_NODE_TYPES.BinaryExpression:
      traverseAndFindMutates(context, node.left, fail, callback);
      traverseAndFindMutates(context, node.right, fail, callback);
      break;
    case AST_NODE_TYPES.CallExpression:
    case AST_NODE_TYPES.NewExpression:
      traverseAndFindMutates(context, node.callee, fail, callback);
      node.arguments.forEach((arg) =>
        traverseAndFindMutates(context, arg, fail, callback),
      );
      break;
    case AST_NODE_TYPES.ArrowFunctionExpression:
    case AST_NODE_TYPES.FunctionExpression:
      traverseAndFindMutates(context, node.body, fail, callback);
      break;
    case AST_NODE_TYPES.AwaitExpression:
    case AST_NODE_TYPES.YieldExpression:
      if (node.argument !== null)
        traverseAndFindMutates(context, node.argument, fail, callback);
      break;
    case AST_NODE_TYPES.TaggedTemplateExpression:
      traverseAndFindMutates(context, node.tag, fail, callback);
      traverseAndFindMutates(context, node.quasi, fail, callback);
      break;

    // Declaration contexts
    case AST_NODE_TYPES.VariableDeclarator:
      if (node.init !== null)
        traverseAndFindMutates(context, node.init, fail, callback);
      break;
    case AST_NODE_TYPES.Property:
    case AST_NODE_TYPES.PropertyDefinition:
      if (node.value !== null)
        traverseAndFindMutates(context, node.value, fail, callback);
      break;

    // JSX contexts
    case AST_NODE_TYPES.JSXExpressionContainer:
      traverseAndFindMutates(context, node.expression, fail, callback);
      break;
    case AST_NODE_TYPES.ThrowStatement:
      traverseAndFindMutates(context, node.argument, fail, callback);
      break;
    case AST_NODE_TYPES.ChainExpression:
      traverseAndFindMutates(context, node.expression, fail, callback);
      break;
    case AST_NODE_TYPES.SpreadElement:
      traverseAndFindMutates(context, node.argument, fail, callback);
      break;
  }
}

function analyzeReactiveness(
  context: ComponentReportContext,
  componentDeclaration: NonNullable<
    ReturnType<typeof parseComponentDeclaration>
  >,
) {
  const properties: { [k: string]: TSESTree.VariableDeclarator | undefined } =
    Object.fromEntries(
      componentDeclaration.reactiveProperties.map(({ name, declarator }) => [
        name,
        declarator,
      ]),
    );

  const names = Object.keys(properties);

  let eventCallbacks = new Map<
    EventCallback,
    Map<TSESTree.CallExpression, TSESTree.VariableDeclarator>
  >();

  let localFunctions = new Map<
    TSESTree.FunctionDeclaration,
    Map<TSESTree.CallExpression, TSESTree.VariableDeclarator>
  >();

  let jsxMap = new Map<TSESTree.CallExpression, TSESTree.VariableDeclarator>();

  function editWithinMap(expression: TSESTree.CallExpression) {
    const name = (expression.arguments[0] as TSESTree.Identifier).name;

    if (!name.startsWith("$")) {
      context.pushError(
        expression.arguments[0].loc,
        "can only mutate component properties",
      );
      context.reportErrors();
      return;
    }

    const actualName = name.slice(1);
    const property = properties[actualName];

    if (property === undefined) {
      context.pushError(
        expression.arguments[0].loc,
        "can only mutate component properties",
      );
      if (distance(closest(actualName, names), actualName) < 5)
        context.pushNote(`maybe you mean ${actualName}?`);
      context.reportErrors();
      return;
    } else {
      return { expression, property };
    }
  }

  let failed = false;

  for (const callback of componentDeclaration.eventCallbacks) {
    let submap = new Map();
    traverseAndFindMutates(
      context,
      callback.callbackArgument.body,
      () => (failed = true),
      (expression) => {
        const value = editWithinMap(expression);

        if (value) submap.set(value.expression, value.property);
      },
    );

    eventCallbacks.set(callback, submap);
  }

  for (const callback of componentDeclaration.localFunctionDeclarations) {
    let submap = new Map();

    traverseAndFindMutates(
      context,
      callback.body,
      () => (failed = true),
      (expression) => {
        const value = editWithinMap(expression);

        if (value) submap.set(value.expression, value.property);
      },
    );

    localFunctions.set(callback, submap);
  }

  traverseAndFindMutates(
    context,
    componentDeclaration.jsxReturn,
    () => (failed = true),
    (expression) => {
      const value = editWithinMap(expression);

      if (value) jsxMap.set(value.expression, value.property);
    },
  );

  if (failed) return null;

  // TODO: create an actual graph from every event callback and local function
  // to the jsx map ast
  //
  // this is going to be used at the codegen stage

  return {
    eventCallbacks,
    localFunctions,
    jsxMap,
  };
}

function analyzeComponent(context: ComponentReportContext, program: Program) {
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

  for (const func of globalFunctionDeclarations) context.registerFunction(func);

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

  const reactiveness = analyzeReactiveness(context, componentDeclaration);
  if (reactiveness === null) {
    context.pushError(
      defaultExport.declaration.loc,
      "reactivity could not compute completely",
    );
    context.reportErrors();
    return;
  }

  return {
    componentDeclaration,
    reactiveness,
  };
}

export function parseRootComponent(file: string, buffer: string) {
  const context = createReportContext(file, buffer);

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
    console.error(`failed building ${file}`);
    return;
  }

  console.dir(component);
}
