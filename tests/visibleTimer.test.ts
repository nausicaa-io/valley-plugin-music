// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { visibleTimer } from '../src/visibleTimer'

describe('visibleTimer', () => {
  let hidden = false
  const setHidden = (value: boolean): void => { hidden = value; document.dispatchEvent(new Event('visibilitychange')) }
  beforeEach(() => { hidden = false; Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden }); vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); delete (document as { hidden?: boolean }).hidden })

  it('ticks while shown, arms nothing while hidden and refreshes when shown again', () => {
    const tick = vi.fn()
    const stop = visibleTimer(document, tick, 1000)
    expect(tick).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(3000)
    expect(tick).toHaveBeenCalledTimes(4)
    setHidden(true)
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(60_000)
    expect(tick).toHaveBeenCalledTimes(4)
    setHidden(false)
    expect(tick).toHaveBeenCalledTimes(5)
    stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('also stops while its element is off screen in a visible document (GODS G6)', () => {
    const observers: Array<{ callback: (entries: Array<{ isIntersecting: boolean }>) => void; disconnect: ReturnType<typeof vi.fn> }> = []
    class FakeObserver {
      disconnect = vi.fn()
      constructor(public callback: (entries: Array<{ isIntersecting: boolean }>) => void) { observers.push(this) }
      observe(): void {}
    }
    const original = (window as { IntersectionObserver?: unknown }).IntersectionObserver
    ;(window as { IntersectionObserver?: unknown }).IntersectionObserver = FakeObserver
    try {
      const tick = vi.fn()
      const stop = visibleTimer(document, tick, 1000, document.createElement('div'))
      expect(tick).toHaveBeenCalledTimes(1)
      observers[0].callback([{ isIntersecting: false }])
      expect(vi.getTimerCount()).toBe(0)
      vi.advanceTimersByTime(5000)
      expect(tick).toHaveBeenCalledTimes(1)
      observers[0].callback([{ isIntersecting: true }])
      expect(tick).toHaveBeenCalledTimes(2)
      vi.advanceTimersByTime(1000)
      expect(tick).toHaveBeenCalledTimes(3)
      stop()
      expect(observers[0].disconnect).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    } finally { (window as { IntersectionObserver?: unknown }).IntersectionObserver = original }
  })
})
