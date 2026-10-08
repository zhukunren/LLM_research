import { afterEach, describe, expect, it, vi } from 'vitest'
import { readModelPreference, writeModelPreference, type ModelSelection } from './modelSelection'

afterEach(() => { sessionStorage.clear(); vi.restoreAllMocks() })

describe('model preference', () => {
  it('stores only validated model and effort strings for this session', () => {
    expect(readModelPreference()).toBeNull()
    const value = { model_id: 'gpt-6-luna', reasoning_effort: 'high' }
    writeModelPreference(value)
    expect(JSON.parse(sessionStorage.getItem('research.modelPreference')!)).toEqual(value)
    expect(readModelPreference()).toEqual(value)
  })

  it.each(['null', '[]', '{invalid', '{"model_id":"gpt-6-luna"}', '{"model_id":"https://secret@example.com","reasoning_effort":"high"}', '{"model_id":"gpt-6-luna","reasoning_effort":"unbounded"}', '{"model_id":"gpt-6-luna","reasoning_effort":"high","api_key":"secret"}'])('ignores malformed or non-preference data: %s', stored => {
    sessionStorage.setItem('research.modelPreference', stored)
    expect(readModelPreference()).toBeNull()
  })

  it('rejects extra credential fields when writing and tolerates blocked storage', () => {
    writeModelPreference({ model_id: 'gpt-6-luna', reasoning_effort: 'high', api_key: 'private' } as ModelSelection)
    expect(sessionStorage.getItem('research.modelPreference')).toBeNull()
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    expect(readModelPreference()).toBeNull()
    expect(() => writeModelPreference({ model_id: 'gpt-6-luna', reasoning_effort: 'low' })).not.toThrow()
  })
})
