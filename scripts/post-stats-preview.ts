/**
 * One-off: render the ledger stats card and POST it as Components V2.
 * Usage: STATS_WEBHOOK_URL='https://discord.com/api/webhooks/...' npx ts-node --transpile-only scripts/post-stats-preview.ts
 * Or: bun scripts/post-stats-preview.ts
 */
import renderStatsCard from '../src/classes/DiscordWebhook/tradeCard/renderStatsCard';
import { collectStatsReadings, type StatsWindow } from '../src/classes/DiscordWebhook/tradeCard/statsFacts';
import type { DailyProfit } from '../src/lib/tools/profitRows';
import { sendWebhook } from '../src/classes/DiscordWebhook/utils';
import { timeNow } from '../src/lib/tools/time';

const COMPONENTS_V2_FLAG = 1 << 15;
const KEY = 64.11;

const window24: StatsWindow = {
    processed: 12,
    accepted: { offer: { total: 5, countered: 1 }, sent: 3 },
    decline: { offer: { total: 2, countered: 0 }, sent: 0 },
    skipped: 1,
    canceled: { total: 1, byUser: 1, failedConfirmation: 0, unknown: 0 },
    invalid: 0
};

const windowToday: StatsWindow = {
    processed: 4,
    accepted: { offer: { total: 2, countered: 0 }, sent: 1 },
    decline: { offer: { total: 1, countered: 0 }, sent: 0 },
    skipped: 0,
    canceled: { total: 0, byUser: 0, failedConfirmation: 0, unknown: 0 },
    invalid: 0
};

function series(): DailyProfit[] {
    const metals = [0.4, -0.2, 1.1, 0, -2.11, 0.3, 2.4, -0.5, 0, 8, 1.2, -1.0, 0.6, 3.22];
    const start = Date.UTC(2026, 7, 6);
    return metals.map((metal, i) => ({
        startMs: start + i * 86400000,
        keys: i === 13 ? 2.14 : 0,
        metal: i === 13 ? 3.22 : metal,
        convertedScrap: Math.round(((i === 13 ? 2.14 : 0) * KEY + (i === 13 ? 3.22 : metal)) * 9)
    }));
}


async function main(): Promise<void> {
    const url = process.env.STATS_WEBHOOK_URL;
    if (!url) {
        throw new Error('Set STATS_WEBHOOK_URL');
    }

    const readings = collectStatsReadings({
        hours24: window24,
        today: windowToday,
        totalDays: 142,
        totalAccepted: 3841,
        keyBuy: 63.88,
        keySell: KEY,
        raw24h: { keys: 6, metal: 222.94 },
        rawAll: { keys: 289, metal: 3849.96 },
        hasEstimates: false,
        sinceDays: 142,
        series: series()
    });

    const card = await renderStatsCard(readings);
    if (!card) {
        throw new Error('renderStatsCard returned null');
    }

    const sentAt = timeNow({
        timezone: process.env.TZ || 'UTC',
        customTimeFormat: ''
    } as never);
    const children = [
        { type: 12 as const, items: [{ media: { url: 'attachment://stats.png' } }] },
        {
            type: 10 as const,
            content: `-# Key rate 63.88 / 64.11 ref\n-# preview\n-# ${sentAt.time}`
        }
    ];

    await sendWebhook(
        url,
        {
            username: 'Stats preview',
            flags: COMPONENTS_V2_FLAG,
            components: [{ type: 17, accent_color: 9171753, components: children }]
        },
        'statistics',
        undefined,
        { name: 'stats.png', buffer: card }
    );

    console.log('posted', card.length, 'byte PNG');
}

void main();
