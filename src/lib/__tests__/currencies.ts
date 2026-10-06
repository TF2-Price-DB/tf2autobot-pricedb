import Currencies from '../currencies';

test.each([
    [0, 0],
    [0.05, 1],
    [0.11, 2],
    [0.33, 6],
    [1, 18],
    [1.55, 28],
    [4000, 72000]
])('converts %s refined to %s half-scrap', (refined, expected) => {
    expect(Currencies.toHalfScrap(refined)).toBe(expected);
});
