import renderStatsCard from '../DiscordWebhook/tradeCard/renderStatsCard';
import { collectStatsReadings, type StatsReadings } from '../DiscordWebhook/tradeCard/statsFacts';
import type { DailyProfit } from '../../lib/tools/profitRows';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const window = {
    processed: 12,
    accepted: { offer: { total: 5, countered: 1 }, sent: 3 },
    decline: { offer: { total: 2, countered: 0 }, sent: 0 },
    skipped: 1,
    canceled: { total: 1, byUser: 1, failedConfirmation: 0, unknown: 0 },
    invalid: 0
};


function zeroDay(startMs: number): DailyProfit {
    return { startMs, keys: 0, metal: 0, convertedScrap: 0 };
}

function fourteenZeros(): DailyProfit[] {
    return Array.from({ length: 14 }, (_, i) => zeroDay(Date.UTC(2026, 7, 6 + i)));
}

function seriesWithSwing(): DailyProfit[] {
    const days = fourteenZeros();
    days[3] = { startMs: days[3].startMs, keys: 0, metal: -2.11, convertedScrap: Math.round(-2.11 * 9) };
    days[10] = { startMs: days[10].startMs, keys: 0, metal: 8, convertedScrap: Math.round(8 * 9) };
    return days;
}

function readings(over: Partial<StatsReadings> = {}): StatsReadings {
    return {
        ...collectStatsReadings({
            hours24: window,
            today: window,
            totalDays: 90,
            totalAccepted: 400,
            keyBuy: 63.55,
            keySell: 64.11,
            raw24h: { keys: 0, metal: 5.36 },
            rawAll: { keys: 2, metal: 10.22 },
            hasEstimates: false,
            sinceDays: 90,
            series: seriesWithSwing()
        }),
        ...over
    };
}

it('returns a PNG', async () => {
    const card = await renderStatsCard(readings());
    expect(card).not.toBeNull();
    expect(card?.subarray(0, 8)).toEqual(PNG);
});

it('omits the plot when every bar is 0 (still returns a PNG)', async () => {
    const card = await renderStatsCard(readings({ series: fourteenZeros() }));
    expect(card).not.toBeNull();
    expect(card?.subarray(0, 8)).toEqual(PNG);
});

