// Ambient declaration for the PRIVATE commercial gateway package.
//
// `@agentkit-commercial/gateway` is an OPTIONAL dependency: it is installed only
// in the hosted (managed-billing) build and is ABSENT in the public / self-host
// build. The composition roots load it at runtime via an optional `require` /
// dynamic `import()` guarded by try/catch, falling back to the free in-memory
// ledger when it's missing.
//
// This loose declaration lets the public monorepo typecheck WITHOUT the package
// installed; the runtime guard handles its real absence. The loaded classes are
// cast to the gateway-core `CreditLedgerRepository` port at the call site.
declare module "@agentkit-commercial/gateway" {
  export const DynamoCreditLedgerRepository: any;
  export const PostgresCreditLedgerRepository: any;
}
