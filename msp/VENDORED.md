# Vendored: msp-ts

`src/vendor/msp-ts/` is the MIT-licensed source of the MSP TypeScript SDK,
[ModelSensingProtocol/msp-ts](https://github.com/ModelSensingProtocol/msp-ts)
(also published as <https://github.com/msp-world/msp-ts>), pinned at commit
**`eb8dc1c0e86aa7eeccbb543ecca34541f815fd15`**.

It is vendored because the SDK is not published to npm yet. It has zero runtime
dependencies, and its sources are compiled into this package's `dist/` (the SDK
uses `.ts` import specifiers; this package builds with
`allowImportingTsExtensions` + `rewriteRelativeImportExtensions`).

The package's `tsconfig` disables `noUnusedLocals` / `noUnusedParameters` so
upstream style does not break the build.

## Local patches

The pinned upstream revision does not typecheck on its own (it is a
work-in-progress source tree). Three minimal patches are applied; everything
else is unchanged:

1. `node.ts` — add the missing `import type { Signal } from "./core/signal.ts";`
   (`on()` referenced `Signal` without importing it).
2. `protocol/protocol.ts` — declare the missing
   `private readonly transport: TransportLike;` field (the constructor assigns
   `this.transport`, but the field declaration was dropped upstream).
3. `protocol/matcher.ts` — treat a bare `**` as "match every path". Upstream
   only implements `base.**`, so `"**"` matches nothing and a subscriber that
   wants every signal has no way to say so; this package's default
   `MSP_SUBSCRIBE=**` relies on it.

Re-apply (or drop, if upstream fixes them) when updating the vendored snapshot.

License: see [`VENDORED-MSP-TS-LICENSE`](VENDORED-MSP-TS-LICENSE) (MIT,
copyright hxh230802).

## Update

```sh
git clone https://github.com/ModelSensingProtocol/msp-ts.git /tmp/msp-ts
git -C /tmp/msp-ts rev-parse HEAD
rm -rf msp/src/vendor/msp-ts
cp -R /tmp/msp-ts/src/. msp/src/vendor/msp-ts/
cp /tmp/msp-ts/LICENSE msp/VENDORED-MSP-TS-LICENSE
```

Update the commit above, re-apply the patches listed above (checking first
whether upstream still needs them), then run `npm test` and `npm run build`
from `msp/`.

When `msp-ts` is published to npm, remove the vendor tree and depend on the
package directly.
