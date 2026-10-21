Vendored from https://github.com/TF2-Price-DB/the-future at
aac76d7edefb522e7fa503b5574af683f16f984a.

Only src/createHat.ts and src/gluedString.ts are included. The import extension
is removed for CommonJS. Error causes use Object.assign and replaceAll uses
split/join for the ES2020 TypeScript library. Array types and redundant non-null assertions are adjusted for local lint rules.
Formatting follows this repository. Preserve LICENSE when updating this copy.
