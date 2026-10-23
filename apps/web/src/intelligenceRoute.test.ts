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
  expect(parseWorkspaceRoute('#/library/news')).toEqual({ page: 'library', libraryTab: 'news' })
  expect(parseWorkspaceRoute('#/library/reports')).toEqual({ page: 'library', libraryTab: 'reports' })
  expect(workspaceRouteHash({ page: 'news' })).toBe('#/library?type=news')
  expect(workspaceRouteHash({ page: 'reports' })).toBe('#/library?type=reports')
  expect(parseWorkspaceRoute('#/library/news?workspace=screening')).toEqual({ page: 'library', libraryTab: 'news', workspace: 'screening' })
  const route = { page: 'library' as const, libraryTab: 'reports' as const, workspace: 'screening' as const }
  expect(parseWorkspaceRoute(workspaceRouteHash(route))).toEqual(route)
})
