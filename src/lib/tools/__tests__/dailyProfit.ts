import { dailyProfitSeries, isCountableProfitTrade, type TradeLike } from '../profitRows';
import { convertedProfitString } from '../profit';

type TradeProfit = {
    rawProfit: { keys: number; metal: number };
    hasEstimates: boolean;
    timestamp: number;
};

function makeTrade(opts: {
    keys?: number;
    metal?: number;
    handleTimestamp?: number;
    timestamp?: number;
    hasEstimates?: boolean;
    tradeProfit?: TradeProfit | null;
    actionReason?: string;
    partner?: string;
    donation?: boolean;
    buyBptfPremium?: boolean;
    handledByUs?: boolean;
    isAccepted?: boolean;
}): TradeLike {
    const timestamp = opts.timestamp ?? Date.now();
    const tradeProfit =
        opts.tradeProfit === null
            ? null
            : opts.tradeProfit !== undefined
            ? opts.tradeProfit
            : {
                  rawProfit: { keys: opts.keys ?? 0, metal: opts.metal ?? 0 },
                  hasEstimates: opts.hasEstimates ?? false,
                  timestamp
              };

    return {
        handleTimestamp: opts.handleTimestamp,
        tradeProfit,
        handledByUs: opts.handledByUs ?? true,
        isAccepted: opts.isAccepted ?? true,
        action: opts.actionReason ? { reason: opts.actionReason } : undefined,
        partner: opts.partner,
        donation: opts.donation,
        buyBptfPremium: opts.buyBptfPremium
    };
}

const TZ = 'UTC';
const KEY = 64.11;
const day = (offset: number, hour = 12): number => Date.UTC(2026, 7, 19 + offset, hour); // Aug 19 2026 ± offset, UTC

describe('isCountableProfitTrade', () => {
    it('skips ADMIN, donation, buyBptfPremium, and isAdmin partner', () => {
        const isAdmin = (id: string) => id === 'admin';
        expect(isCountableProfitTrade(makeTrade({ actionReason: 'ADMIN' }), isAdmin)).toBe(false);
        expect(isCountableProfitTrade(makeTrade({ donation: true }), isAdmin)).toBe(false);
        expect(isCountableProfitTrade(makeTrade({ buyBptfPremium: true }), isAdmin)).toBe(false);
        expect(isCountableProfitTrade(makeTrade({ partner: 'admin' }), isAdmin)).toBe(false);
        expect(isCountableProfitTrade(makeTrade({ partner: 'someone' }), isAdmin)).toBe(true);
    });

    it('skips trades without FIFO profit data, not handled by us, or not accepted', () => {
        expect(isCountableProfitTrade(makeTrade({ tradeProfit: null }), () => false)).toBe(false);
        expect(isCountableProfitTrade(makeTrade({ handledByUs: false }), () => false)).toBe(false);
        expect(isCountableProfitTrade(makeTrade({ isAccepted: false }), () => false)).toBe(false);
    });

    it('falls back to tradeProfit.timestamp when handleTimestamp is missing', () => {
        const isAdmin = () => false;
        const ts = day(0, 6);
        expect(isCountableProfitTrade(makeTrade({ timestamp: ts, handleTimestamp: undefined }), isAdmin)).toBe(true);
        // isCountable does not read timestamps; the fallback is exercised in
        // dailyProfitSeries below.
    });
});

describe('dailyProfitSeries', () => {
    it('buckets trades into local-timezone days', () => {
        const now = Date.UTC(2026, 7, 19, 23); // Aug 19 23:00 UTC
        const series = dailyProfitSeries(
            [
                makeTrade({ keys: 1, metal: 0, handleTimestamp: day(0, 1) }),
                makeTrade({ keys: 0, metal: 9, handleTimestamp: day(0, 5) }),
                makeTrade({ keys: 0, metal: 4.5, handleTimestamp: day(-1, 22) }),
                makeTrade({ keys: 2, metal: 0, handleTimestamp: day(-3, 1) }),
                makeTrade({ keys: 1, metal: 0, handleTimestamp: day(-20, 1) }) // outside window
            ],
            () => false,
            KEY,
            TZ,
            now,
            7
        );

        expect(series).toHaveLength(7);
        const today = series[6];
        const yesterday = series[5];
        expect(today.keys).toBe(1);
        expect(today.metal).toBe(9);
        expect(yesterday.metal).toBe(4.5);
        // day(-3) is within the 7-day window
        expect(series[3].keys).toBe(2);
        // outside-window trade lands nowhere
        const totalKeys = series.reduce((s, d) => s + d.keys, 0);
        expect(totalKeys).toBe(3);
    });

    it('honors the bot timezone when bucketing day boundaries', () => {
        // 2026-08-19 23:30 UTC = 2026-08-20 in Tokyo (UTC+9)
        const tradeTs = Date.UTC(2026, 7, 19, 23, 30);
        const now = Date.UTC(2026, 7, 20, 12);
        const series = dailyProfitSeries(
            [makeTrade({ keys: 1, metal: 0, handleTimestamp: tradeTs })],
            () => false,
            KEY,
            'Asia/Tokyo',
            now,
            3
        );
        expect(series[2].keys).toBe(1); // lands on Aug 20 Tokyo time
        expect(series[1].keys).toBe(0);
    });

    it('uses tradeProfit.timestamp when handleTimestamp is missing', () => {
        const ts = day(-1, 10);
        const now = Date.UTC(2026, 7, 19, 23);
        const series = dailyProfitSeries(
            [makeTrade({ keys: 1, metal: 0, handleTimestamp: undefined, timestamp: ts })],
            () => false,
            KEY,
            TZ,
            now,
            3
        );
        expect(series[1].keys).toBe(1);
    });

    it('skips non-countable trades', () => {
        const now = Date.UTC(2026, 7, 19, 23);
        const series = dailyProfitSeries(
            [
                makeTrade({ keys: 1, metal: 0, handleTimestamp: day(0, 1) }),
                makeTrade({ keys: 5, metal: 0, handleTimestamp: day(0, 2), actionReason: 'ADMIN' }),
                makeTrade({ keys: 5, metal: 0, handleTimestamp: day(0, 3), tradeProfit: null })
            ],
            () => false,
            KEY,
            TZ,
            now,
            3
        );
        expect(series[2].keys).toBe(1);
    });

    it('converts each day to scrap at the sell key rate', () => {
        const now = Date.UTC(2026, 7, 19, 23);
        const series = dailyProfitSeries(
            [makeTrade({ keys: 1, metal: 0, handleTimestamp: day(0, 1) })],
            () => false,
            KEY,
            TZ,
            now,
            3
        );
        // 1 key at 64.11 ref = 577 scrap (rounded)
        expect(series[2].convertedScrap).toBe(Math.round(KEY * 9));
    });
});

describe('convertedProfitString', () => {
    it('converts keys+metal into a currencies string at the sell rate', () => {
        expect(convertedProfitString(1, 11, KEY)).toBe('1 key, 11 ref');
        expect(convertedProfitString(0, 22, KEY)).toBe('22 ref');
    });
});
