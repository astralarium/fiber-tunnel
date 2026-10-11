// Minimal ambient types for react-reconciler 0.33 and 0.34.

declare module "react-reconciler" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Any = any;
  export interface FiberRootHandle {
    current: unknown;
    pendingLanes: number;
    suspendedLanes: number;
    pingedLanes: number;
    warmLanes: number;
    callbackPriority: number;
  }
  export interface ReconcilerInstance {
    createContainer(
      containerInfo: Any,
      tag: number,
      hydrationCallbacks: null,
      isStrictMode: boolean,
      concurrentUpdatesByDefaultOverride: null,
      identifierPrefix: string,
      onUncaughtError: (error: unknown) => void,
      onCaughtError: (error: unknown) => void,
      onRecoverableError: (error: unknown) => void,
      onDefaultTransitionIndicator: null,
    ): FiberRootHandle;
    updateContainer(
      element: Any,
      container: FiberRootHandle,
      parentComponent: null,
      callback: null,
    ): number;
    flushSyncFromReconciler<T>(fn: () => T): T;
    flushSyncWork(): void;
    flushPassiveEffects(): boolean;
  }
  const Reconciler: (config: Record<string, Any>) => ReconcilerInstance;
  export default Reconciler;
}

declare module "react-reconciler/constants" {
  export const ConcurrentRoot: number;
  export const NoEventPriority: number;
  export const DiscreteEventPriority: number;
  export const ContinuousEventPriority: number;
  export const DefaultEventPriority: number;
  export const IdleEventPriority: number;
}
