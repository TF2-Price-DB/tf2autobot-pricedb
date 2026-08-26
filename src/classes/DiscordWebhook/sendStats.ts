import SteamID from 'steamid';
import SteamTradeOfferManager from '@tf2autobot/tradeoffer-manager';
import { sendWebhook } from './utils';
import { Container, Webhook } from './interfaces';
import log from '../../lib/logger';
import { stats, profit, timeNow } from '../../lib/tools/export';
import { dailyProfitSeries } from '../../lib/tools/profitRows';
import Bot from '../Bot';
import loadPollData from '../../lib/tools/polldata';
import { collectStatsReadings, type StatsReadings } from './tradeCard/statsFacts';
import { renderCard } from './tradeCard/cardRenderClient';

/** `IS_COMPONENTS_V2` — required on any message that sets `components`. */
const COMPONENTS_V2_FLAG = 1 << 15;

export default async function sendStats(bot: Bot, forceSend = false, steamID?: SteamID): Promise<void> {
    const optDW = bot.options.discordWebhook;
    const botInfo = bot.handler.getBotInfo;
    const pollData = loadPollData(bot.handler.getPaths.files.dir);

    if (!pollData) {
        return;
    }

    const readings = await collectStatsReadingsForBot(bot, pollData);

    const card = await renderCard({ type: 'stats', readings });

    const children: Container['components'] = [];

    if (card) {
        children.push({ type: 12, items: [{ media: { url: 'attachment://stats.png' } }] });
    }

    if (readings.hasEstimates) {
        children.push({ type: 10, content: '⚠️ Contains estimates' });
    }

    const sentAt = timeNow(bot.options);
    children.push({
        type: 10,
        content:
            `-# Key rate ${readings.keyBuy} / ${readings.keySell} ref\n` +
            `-# ${process.env.BOT_VERSION_LABEL}\n` +
            `-# ${sentAt.time}`
    });

    const payload: Webhook = {
        username: optDW.displayName || botInfo.name,
        avatar_url: optDW.avatarURL || botInfo.avatarURL,
        flags: COMPONENTS_V2_FLAG,
        components: [
            {
                type: 17,
                accent_color: Number(optDW.embedColor),
                components: children
            }
        ]
    };

    sendWebhook(
        optDW.sendStats.url,
        payload,
        'statistics',
        undefined,
        card ? { name: 'stats.png', buffer: card } : undefined
    )
        .then(() => {
            if (forceSend) {
                bot.sendMessage(steamID, '✅ Sent statistics to Discord Webhook!');
            }
        })
        .catch(err => {
            log.warn(`❌ Failed to send statistics webhook to Discord: `, err);
            if (forceSend) {
                const errStringify = JSON.stringify(err);
                const errMessage = errStringify === '' ? (err as Error)?.message : errStringify;
                bot.sendMessage(steamID, '❌ Error sending statistics to Discord Webhook: ' + errMessage);
            }
        });
}

export async function collectStatsReadingsForBot(
    bot: Bot,
    pollData: SteamTradeOfferManager.PollData
): Promise<StatsReadings> {
    const trades = stats(bot, pollData);
    const profits = await profit(bot, pollData, Math.floor((Date.now() - 86400000) / 1000));

    const tradesFromEnv = bot.options.statistics.lastTotalTrades;
    const keyPrices = bot.pricelist.getKeyPrices;

    const tradesList = Object.keys(pollData.offerData ?? {}).map(id => pollData.offerData[id]);

    const series = dailyProfitSeries(
        tradesList,
        id => bot.isAdmin(id),
        keyPrices.sell.metal,
        bot.options.timezone || 'UTC',
        Date.now(),
        14
    );

    return collectStatsReadings({
        hours24: trades.hours24,
        today: trades.today,
        totalDays: trades.totalDays,
        totalAccepted: tradesFromEnv ? tradesFromEnv + trades.totalAcceptedTrades : trades.totalAcceptedTrades,
        keyBuy: keyPrices.buy.metal,
        keySell: keyPrices.sell.metal,
        raw24h: profits.rawProfitTimed,
        rawAll: profits.rawProfit,
        hasEstimates: profits.hasEstimates,
        sinceDays: profits.since,
        series
    });
}
