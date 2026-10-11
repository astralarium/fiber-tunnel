/** A one-shot thenable `use()` reads synchronously once resolved. */
export interface Signal {
  thenable: PromiseLike<void>;
  resolve(): void;
  readonly done: boolean;
}

export function createSignal(): Signal {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  // React reads `status` to skip suspending on a settled thenable.
  const tagged = Object.assign(promise, {
    status: "pending" as string,
    value: undefined,
  });
  return {
    thenable: tagged,
    resolve() {
      if (tagged.status !== "pending") return;
      tagged.status = "fulfilled";
      resolvePromise();
    },
    get done() {
      return tagged.status === "fulfilled";
    },
  };
}
