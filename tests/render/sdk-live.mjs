// The render stub with the host's real query library: '@tanstack/react-query' at the version Desktop pins
// (apps/desktop/package.json). Used by interact.mjs, where refetch timing matters; run.mjs keeps the static
// stub. Local exports here take precedence over the star export.
export * from './sdk-stub.mjs'
export { useQuery, useQueryClient } from '@tanstack/react-query'
