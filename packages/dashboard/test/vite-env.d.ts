// Pulls in the `declare module "cloudflare:test"` types from the workers
// vitest pool so `env` bindings typecheck under `tsc -b`.
/// <reference types="@cloudflare/vitest-pool-workers" />

// Allows `import sql from '.../0001_init.sql?raw'` in tests.
declare module '*?raw' {
  const content: string;
  export default content;
}
