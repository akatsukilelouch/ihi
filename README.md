# ihi

Ihi is a web framework that allows creating very-small practically-no-runtime (except for dynamic shims when you want to influence application render from outside component files) optimized JavaScript component-based applications akin to React, Preact or its derivatives. In comparison to Vue or Svelte or Angular, a component is described in JSX syntax but declaratively (except for actual functions or imperative code in listeners/callbacks).

This is a PoC version written in TypeScript since that's the first thing I found typescript + tsx supported parsers right away.

## Example

```tsx
// input.ihi.tsx
export default function() {
  let $value;

  $$watch($value, (input) => {
    $$dispatchUpwards("input::update", input);
  });

  return <input bind:{value}></input>
}

// chat.ihi.tsx
export default function() {
  let $value;

  $$on("input::update", (value) => {
    $value = value;

    $$dispatchDownwards("input::update", value, INPUT);
  }, {
    from: INPUT,
    deep: true,
  });

  return <Input:ihi as:INPUT />;
}
```

Everything is built around these `$$`-ish magic functions that are compiled to a very optimized JavaScript. There is almost no dynamic routing between components when they are called.
