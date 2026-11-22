// Use the real query library for the interaction tests that depend on refetch timing.
export * from './sdk-stub.mjs'
export { useQuery, useQueryClient } from '@tanstack/react-query'
