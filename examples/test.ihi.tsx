/// <reference path=".d.ts" />
//

export default function () {
  let $a = 32;

  $on("data", (e: number) => {
    $mutate($a);
    $mutate($b);

    $dispatchUp("fooo", 32, {});
  });

  return <foo></foo>;
}
