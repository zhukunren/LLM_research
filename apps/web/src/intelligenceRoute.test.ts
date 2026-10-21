import { expect, it } from 'vitest'
import { parseWorkspaceRoute, workspaceRouteHash } from './workspaceRoute'

it('roundtrips each intelligence kind and immutable version', () => {
  for (const briefKind of ['market', 'policy', 'industry', 'closing', 'stock-analysis', 'stock-rationale'] as const) {
    const route = { page: 'intelligence' as const, briefKind, briefId: 'saved-version-1' }
    expect(parseWorkspaceRoute(workspaceRouteHash(route))).toEqual(route)
  }
  expect(parseWorkspaceRoute('#/intelligence')).toEqual({ page: 'intelligence', briefKind: 'market' })
  expect(parseWorkspaceRoute('#/intelligence/unknown')).toBeNull()
  expect(parseWorkspaceRoute('#/intelligence/market/bad%2Fid')).toBeNull()
})

it('keeps legacy library links readable and roundtrips the unified library', () => {
  expect(parseWorkspaceRoute('#/library/news')).toMatchObject({ page: 'news' })
  expect(parseWorkspaceRoute('#/library/reports')).toMatchObject({ page: 'reports' })
  const route = { page: 'library' as const, libraryTab: 'reports' as const, workspace: 'screening' as const }
  expect(parseWorkspaceRoute(workspaceRouteHash(route))).toEqual(route)
})
