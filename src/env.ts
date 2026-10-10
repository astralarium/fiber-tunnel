// Node types are absent.
declare const process: { env: { NODE_ENV?: string } };

/** True outside production builds. Unguarded so bundlers drop dev code. */
export const isDevEnv = process.env.NODE_ENV !== "production";
