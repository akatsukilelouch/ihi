declare function $on(event: string, callback: () => void): void;

export default function () {
  let $a = 32;

  $on("data", (e) => {
    $mutate($a);
  });

  return <foo></foo>;
}
