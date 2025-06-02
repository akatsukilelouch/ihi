import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/typescript-estree";
import { FileContext } from "./context";
import { Component, parseMagicFunctionExpression } from "./parse";
import { closest, distance } from "fastest-levenshtein";

enum Effect {
  Mutate,
  Dispatch,
}

type SideEffect =
  | {
      effect: Effect.Mutate;
      variable: string;
    }
  | {
      effect: Effect.Dispatch;
      event: string;
    };

type ComponentWithMeta = {
  component: Component;
  path: string;
};

type RegisteredEvent = {
  name: string;
  owning: ComponentWithMeta;
};

function componentToReactiveNames({ componentDeclaration }: Component) {
  return componentDeclaration.reactiveProperties.map(({ name }) => name);
}

function makeRegisteredEvents(componentWithMeta: ComponentWithMeta) {
  return componentWithMeta.component.componentDeclaration.eventCallbacks.map(
    (callback) =>
      ({
        name: callback.eventName,
        owning: componentWithMeta,
      }) as RegisteredEvent,
  );
}

type FlowContext = {
  localNames: string[];
  globalEvents: RegisteredEvent[];
};

export function analyzeDispatch(
  reportContext: FileContext,
  flowContext: FlowContext,
  magicFunction: NonNullable<ReturnType<typeof parseMagicFunctionExpression>>,
) {
  if (
    magicFunction.name !== "dispatchUp" &&
    magicFunction.name !== "dispatchDown"
  )
    return;

  // Validate argument count
  if (magicFunction.expression.arguments.length !== 3) {
    reportContext.pushError(
      magicFunction.expression.arguments.length > 0
        ? magicFunction.expression.arguments[0].loc
        : magicFunction.expression.loc,
      `$${magicFunction.name} expects exactly 3 arguments: event, data, and options`,
    );

    return null;
  }

  // Validate event name is a string literal and exists in registered events
  const eventArg = magicFunction.expression.arguments[0];
  if (eventArg.type !== AST_NODE_TYPES.Literal) {
    reportContext.pushError(
      magicFunction.expression.arguments[0].loc,
      `event must be a string literal`,
    );
    return null;
  }

  const event = eventArg as TSESTree.Literal;
  if (typeof event.value !== "string") {
    // thank you tsestree
    reportContext.pushError(
      magicFunction.expression.arguments[0].loc,
      `${event.raw} is not a valid event name`,
    );
    return null;
  }

  if (
    flowContext.globalEvents.find((other) => event.value === other.name) ===
    undefined
  ) {
    reportContext.pushError(
      magicFunction.expression.arguments[0].loc,
      `${event.raw} is not registered anywhere`,
    );

    const sorted = flowContext.globalEvents
      .map((other) => ({
        distance: distance(event.value, other.name),
        event: other,
      }))
      .sort((a, b) => a.distance - b.distance);

    let i = 0;
    for (; i < 3 && i < sorted.length - 1; ++i) {
      if (Math.abs(sorted[i].distance - sorted[i + 1].distance) > 3) break;
    }

    for (const item of sorted.slice(0, i + 1))
      reportContext.pushNote(
        `maybe you meant ${item.event.name} from ${item.event.owning.path}?`,
      );

    return null;
  }

  return {
    effect: Effect.Dispatch,
    event: event.value,
  } as SideEffect;
}

function tryFindClosestProperty(
  flowContext: FlowContext,
  name: string,
): string[] {
  const sorted = flowContext.localNames
    .map((other) => ({ distance: distance(name, other), name: other }))
    .sort((a, b) => a.distance - b.distance);

  let i = 0;
  for (; i < 3 && i < sorted.length - 1; ++i) {
    if (Math.abs(sorted[i].distance - sorted[i + 1].distance) > 3) break;
  }

  return sorted.slice(0, i + 1).map(({ name }) => name);
}

function analyzeMutation(
  reportContext: FileContext,
  flowContext: FlowContext,
  magicFunction: NonNullable<ReturnType<typeof parseMagicFunctionExpression>>,
) {
  if (magicFunction.name !== "mutate") return;

  if (magicFunction.expression.arguments.length !== 1) {
    reportContext.pushError(
      magicFunction.expression.loc,
      "magic function call @mutate shall take a reactive variable in",
    );
    reportContext.reportErrors();
    return null;
  }

  const targetVariable = magicFunction.expression.arguments[0];
  if (targetVariable.type !== AST_NODE_TYPES.Identifier) {
    reportContext.pushError(
      targetVariable.loc,
      "magic function call @mutate shall take a reactive variable",
    );
      if (
        targetVariable.type === AST_NODE_TYPES.Literal &&
        targetVariable.raw.startsWith('"$')
      ) {
        for (const property of tryFindClosestProperty(
          flowContext,
          (targetVariable.value as string).slice(1),
        ))
          reportContext.pushNote(
            `you probably meant property $${property} instead of a literal ${targetVariable.raw}`,
          );
      }
    reportContext.reportErrors();
    return null;
  }

  if (flowContext.localNames.find(other => targetVariable.name.slice(1) === other) === undefined) {
    reportContext.pushError(targetVariable.loc, `unknown property ${targetVariable.name}`);

    const closestProperties = tryFindClosestProperty(
      flowContext,
      (targetVariable.name as string).slice(1),
    );

    for (const property of closestProperties)
      reportContext.pushNote(
        `you probably meant property $${property} instead of ${targetVariable.name}`,
      );

    reportContext.reportErrors();
    return null;
  }

  return {
    effect: Effect.Mutate,
    variable: targetVariable.name.slice(1), // without the dollar sign
  } as SideEffect;
}

function collectSideEffects(
  reportContext: FileContext,
  flowContext: FlowContext,
  node: TSESTree.Node,
): SideEffect[] {
  // First check if this node is an assignment expression
  if (node.type === AST_NODE_TYPES.CallExpression) {
    const magicFunction = parseMagicFunctionExpression(reportContext, node);

    if (magicFunction !== null) {
      {
        const mutation = analyzeMutation(
          reportContext,
          flowContext,
          magicFunction,
        );
        if (mutation === null) {
          reportContext.reportErrors();
        } else if (mutation !== undefined) {
          return [mutation];
        }
      }

      {
        const dispatch = analyzeDispatch(
          reportContext,
          flowContext,
          magicFunction,
        );
        if (dispatch === null) {
          reportContext.reportErrors();
        } else if (dispatch !== undefined) {
          return [dispatch];
        }
      }

      reportContext.pushError(
        magicFunction.expression.loc,
        "this is not a valid $mutate or a valid $dispatchUp/$dispatchDown call",
      );
      reportContext.reportErrors();
      return [];
    }

    reportContext.discardErrors();
  }

  // traverse all possible children that could contain @mutate(#variable)
  switch (node.type) {
    case AST_NODE_TYPES.ExpressionStatement:
      return collectSideEffects(reportContext, flowContext, node.expression);
    case AST_NODE_TYPES.BlockStatement:
      return node.body.flatMap((stmt) =>
        collectSideEffects(reportContext, flowContext, stmt),
      );
    case AST_NODE_TYPES.IfStatement:
      return [
        ...collectSideEffects(reportContext, flowContext, node.test),
        ...collectSideEffects(reportContext, flowContext, node.consequent),
        ...(node.alternate
          ? collectSideEffects(reportContext, flowContext, node.alternate)
          : []),
      ];
    case AST_NODE_TYPES.WhileStatement:
      return [
        ...collectSideEffects(reportContext, flowContext, node.test),
        ...collectSideEffects(reportContext, flowContext, node.body),
      ];
    case AST_NODE_TYPES.DoWhileStatement:
      return [
        ...collectSideEffects(reportContext, flowContext, node.body),
        ...collectSideEffects(reportContext, flowContext, node.test),
      ];

    case AST_NODE_TYPES.ForStatement:
      return [
        ...(node.init
          ? collectSideEffects(reportContext, flowContext, node.init)
          : []),
        ...(node.test
          ? collectSideEffects(reportContext, flowContext, node.test)
          : []),
        ...(node.update
          ? collectSideEffects(reportContext, flowContext, node.update)
          : []),
        ...collectSideEffects(reportContext, flowContext, node.body),
      ];
    case AST_NODE_TYPES.ForInStatement:
    case AST_NODE_TYPES.ForOfStatement:
      return [
        ...collectSideEffects(reportContext, flowContext, node.right),
        ...collectSideEffects(reportContext, flowContext, node.left),
        ...collectSideEffects(reportContext, flowContext, node.body),
      ];

    // Other containers
    case AST_NODE_TYPES.SwitchStatement:
      return [
        ...collectSideEffects(reportContext, flowContext, node.discriminant),

        ...node.cases.flatMap((c) => [
          ...(c.test
            ? collectSideEffects(reportContext, flowContext, c.test)
            : []),
          ...c.consequent.flatMap((stmt) =>
            collectSideEffects(reportContext, flowContext, stmt),
          ),
        ]),
      ];

    case AST_NODE_TYPES.ReturnStatement:
      if (node.argument)
        return collectSideEffects(reportContext, flowContext, node.argument);
      else return [];

    // Expression containers
    case AST_NODE_TYPES.ArrayExpression:
      return node.elements.flatMap((element) => {
        if (element !== null)
          return collectSideEffects(reportContext, flowContext, element);
        else return [];
      });
    case AST_NODE_TYPES.ObjectExpression:
      return node.properties.flatMap((prop) =>
        collectSideEffects(reportContext, flowContext, prop),
      );
    case AST_NODE_TYPES.SequenceExpression:
      return node.expressions.flatMap((expr) =>
        collectSideEffects(reportContext, flowContext, expr),
      );
    case AST_NODE_TYPES.ConditionalExpression:
      return [
        ...collectSideEffects(reportContext, flowContext, node.test),
        ...collectSideEffects(reportContext, flowContext, node.consequent),
        ...collectSideEffects(reportContext, flowContext, node.alternate),
      ];
    case AST_NODE_TYPES.LogicalExpression:
    case AST_NODE_TYPES.BinaryExpression:
      return [
        ...collectSideEffects(reportContext, flowContext, node.left),
        ...collectSideEffects(reportContext, flowContext, node.right),
      ];
    case AST_NODE_TYPES.CallExpression:
    case AST_NODE_TYPES.NewExpression:
      return [
        ...node.arguments.flatMap((arg) =>
          collectSideEffects(reportContext, flowContext, arg),
        ),
        ...collectSideEffects(reportContext, flowContext, node.callee),
      ];
    case AST_NODE_TYPES.ArrowFunctionExpression:
    case AST_NODE_TYPES.FunctionExpression:
      return collectSideEffects(reportContext, flowContext, node.body);
    case AST_NODE_TYPES.AwaitExpression:
    case AST_NODE_TYPES.YieldExpression:
      if (node.argument !== null)
        return collectSideEffects(reportContext, flowContext, node.argument);
      else return [];
    case AST_NODE_TYPES.TaggedTemplateExpression:
      return [
        ...collectSideEffects(reportContext, flowContext, node.tag),
        ...collectSideEffects(reportContext, flowContext, node.quasi),
      ];

    // Declaration contexts
    case AST_NODE_TYPES.VariableDeclarator:
      if (node.init !== null)
        return collectSideEffects(reportContext, flowContext, node.init);
      else return [];
    case AST_NODE_TYPES.Property:
    case AST_NODE_TYPES.PropertyDefinition:
      if (node.value !== null)
        return collectSideEffects(reportContext, flowContext, node.value);
      else return [];

    // JSX contexts
    case AST_NODE_TYPES.JSXExpressionContainer:
      return collectSideEffects(reportContext, flowContext, node.expression);
    case AST_NODE_TYPES.ThrowStatement:
      return collectSideEffects(reportContext, flowContext, node.argument);
    case AST_NODE_TYPES.ChainExpression:
      return collectSideEffects(reportContext, flowContext, node.expression);
    case AST_NODE_TYPES.SpreadElement:
      return collectSideEffects(reportContext, flowContext, node.argument);

    default:
      return [];
  }
}

export type ComponentTree = {
  parent: ComponentWithMeta;
  children: ComponentTree[];
};

export function traverseTreeLinear<T>(
  tree: ComponentTree,
  callback: (component: ComponentWithMeta) => T[],
): T[] {

  return [
    ...callback(tree.parent),
    ...tree.children.flatMap((tree) => traverseTreeLinear(tree, callback)),
  ];
}

function gatherAllEvents(tree: ComponentTree) {
  return traverseTreeLinear(tree, (component) =>
    makeRegisteredEvents(component),
  );
}

export function analyzeReactiveness(
  fileContext: FileContext,
  tree: ComponentTree,
) {
  // const properties: { [k: string]: TSESTree.VariableDeclarator | undefined } =
  //   Object.fromEntries(
  //     component.componentDeclaration.reactiveProperties.map(({ name, declarator }) => [
  //       name,
  //       declarator,
  //     ]),
  //   );

  const flowContext: FlowContext = {
    localNames: componentToReactiveNames(tree.parent.component),
    globalEvents: gatherAllEvents(tree),
  };

  return {
    tree,
    effects: Object.fromEntries(
      tree.parent.component.componentDeclaration.eventCallbacks.map(
        (callback) => [
          callback.eventName,
          collectSideEffects(
            fileContext,
            flowContext,
            callback.callbackArgument.body,
          ),
        ],
      ),
    ),
  };
}
