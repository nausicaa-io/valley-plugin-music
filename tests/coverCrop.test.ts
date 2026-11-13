import { describe, expect, it } from 'vitest'
import { coverCropStyle, readCoverCrops } from '../src/data'

describe('cover framing', () => {
  it('reads stored crops, clamping values and dropping malformed entries', () => {
    expect(readCoverCrops({
      'artist:a': { image: 'a.jpg', x: 120, y: -5, zoom: 9 },
      'playlist:p': { image: 'p.jpg', x: 30, y: 40, zoom: 1.5 },
      'artist:bad': { x: 10 },
      'artist:junk': 'nope'
    })).toEqual({
      'artist:a': { image: 'a.jpg', x: 100, y: 0, zoom: 4 },
      'playlist:p': { image: 'p.jpg', x: 30, y: 40, zoom: 1.5 }
    })
    expect(readCoverCrops(null)).toEqual({})
    expect(readCoverCrops([1, 2])).toEqual({})
  })

  it('frames only the image the crop was made for', () => {
    const crop = { image: 'a.jpg', x: 25, y: 10, zoom: 1 }
    expect(coverCropStyle(crop, 'b.jpg')).toBeUndefined()
    expect(coverCropStyle(undefined, 'a.jpg')).toBeUndefined()
    expect(coverCropStyle(crop, 'a.jpg')).toEqual({ objectFit: 'cover', objectPosition: '25% 10%' })
  })

  it('zooms around the focal point and clips back to the original box', () => {
    const style = coverCropStyle({ image: 'a.jpg', x: 50, y: 0, zoom: 2 }, 'a.jpg', '50%')
    expect(style).toEqual({
      objectFit: 'cover',
      objectPosition: '50% 0%',
      transformOrigin: '50% 0%',
      transform: 'scale(2)',
      clipPath: 'inset(0% 25% 50% 25% round calc(50% / 2))'
    })
  })
})
