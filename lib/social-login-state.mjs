// Client-side UX guard only. The server's rate limiter remains authoritative.
export function retryDelaySeconds(headers, now = Date.now()) {
  for (const name of ['Retry-After', 'X-Retry-After']) {
    const value = headers?.get(name)?.trim()
    if (!value) continue
    const seconds = /^\d+(\.\d+)?$/.test(value)
      ? Number(value)
      : name === 'Retry-After' && !/^-/.test(value) ? (Date.parse(value) - now) / 1000 : NaN
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(86400, Math.max(1, Math.ceil(seconds)))
  }
  return 10
}

export function createSocialLoginState(now = Date.now) {
  let state = { pending: false, retryAt: 0, observedAt: 0 }
  const listeners = new Set()
  const update = (next) => { state = next; for (const listener of listeners) listener() }
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    async run(request) {
      if (state.pending) return 'busy'
      if (state.retryAt > now()) return 'rate-limited'
      update({ pending: true, retryAt: 0, observedAt: now() })
      let limited = false
      const markLimited = (headers) => {
        limited = true
        const receivedAt = now()
        update({ ...state, observedAt: receivedAt, retryAt: receivedAt + retryDelaySeconds(headers, receivedAt) * 1000 })
      }
      try {
        const result = await request({
          retry: 0,
          onError: ({ response }) => { if (response?.status === 429) markLimited(response.headers) },
        })
        if (result?.error?.status === 429 && !limited) markLimited()
        return limited ? 'rate-limited' : result?.error ? 'error' : 'success'
      } catch {
        return limited ? 'rate-limited' : 'error'
      } finally {
        update({ ...state, pending: false })
      }
    },
  }
}
