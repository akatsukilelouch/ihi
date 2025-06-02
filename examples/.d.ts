declare function $on(event: "data", callback: (data: number) => MaybePromise<void>)
declare function $dispatchUp(event: "data", data: number, options: {}): void
declare function $dispatchDown(event: "data", data: number, options: {}): void
declare function $mutate(...variables: any[]): void
declare function $watch<T>(variable: T, callback: (value: T) => MaybePromise<void>): void