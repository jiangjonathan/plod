# Contributing

Plod is currently a TypeScript-first browser plotting library. Keep changes small, typed, and covered by the existing strict TypeScript checks.

## Local Setup

```sh
npm install
npm test
npm run typecheck
npm run build
```

## Pull Requests

- Keep public API changes explicit in `src/index.ts` and document user-facing behavior in `README.md` or `docs/`.
- Keep demo-site, benchmark, dataset, and chart-studio code in their respective repositories.
- Prefer small, focused changes over broad rewrites.
- Do not commit generated output from `dist/`, local logs, or dependency directories.
- Run `npm test` and `npm run build` before opening a pull request.

## Coding Standards

- Preserve strict TypeScript settings.
- Avoid `any` in library code unless it is isolated at a boundary with a clear reason.
- Keep rendering hot paths allocation-aware.
- Prefer explicit cache invalidation over hidden mutable state.
