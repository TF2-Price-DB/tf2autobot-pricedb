import Bot from '../../classes/Bot';
import dayjs from 'dayjs';
import SteamTradeOfferManager from '@tf2autobot/tradeoffer-manager';

// FIFO-based profit calculation — reads directly from SQLite, not from in-memory pollData.

interface Profit {
    rawProfit: {
        keys: number;
        metal: number;
    };
    rawProfitTimed: {
        keys: number;
        metal: number;
    };
    since: number; // Days since first trade
    hasEstimates?: boolean; // True if FIFO fallback or legacy calculation was used
}

/**
 * Calculate profit using FIFO-based TradeProfitData stored in SQLite.
 * The pollData parameter is accepted but unused — it exists only for backward compatibility
 * with existing call sites. Pass undefined or omit it.
 */
export default async function profit(
    bot: Bot,
    _pollData?: SteamTradeOfferManager.PollData,
    start = 0
): Promise<Profit> {
    return new Promise(resolve => {
        const now = dayjs();
        const twentyFourHoursAgo = now.subtract(24, 'hour').valueOf();

        let totalRawKeys = 0;
        let totalRawMetal = 0;
        let timedRawKeys = 0;
        let timedRawMetal = 0;
        let hasEstimates = false;
        let earliestTradeTs: number | undefined;

        // Query DB for all offers that have FIFO profit data, ordered oldest-first.
        const rows = bot.db.getProfitRows();

        if (rows.length === 0) {
            const fromPrevious = {
                made: bot.options.statistics.lastTotalProfitMadeInRef,
                since: bot.options.statistics.profitDataSinceInUnix
            };

            const timeSince = fromPrevious.since === 0 ? undefined : fromPrevious.since;

            return resolve({
                rawProfit: { keys: 0, metal: fromPrevious.made },
                rawProfitTimed: { keys: 0, metal: 0 },
                since: !timeSince ? 0 : now.diff(dayjs.unix(timeSince), 'day')
            });
        }

        for (const trade of rows) {
            // skips rows the bot didnt directly handle or where not accepted yet
            if (!(trade.handledByUs && trade.isAccepted)) {
                continue;
            }

            // Skip admin / premium-buy / donation trades
            if (trade.action?.reason === 'ADMIN' || bot.isAdmin(trade.partner)) {
                continue;
            }

            if (trade.donation || trade.buyBptfPremium) {
                continue;
            }

            const tradeProfit = trade.tradeProfit;

            if (!tradeProfit) {
                // Old trade without FIFO profit tracking — skip.
                // Accurate FIFO data only exists for trades processed after the new system.
                continue;
            }

            // Capture timestamp of first SQLite row instead.
            // handleTimestamp and tradeProfit.timestamp are both in milliseconds (Date.now() / dayjs().valueOf()).
            // Convert to seconds here so it is consistent with profitDataSinceInUnix and dayjs.unix() below.
            if (earliestTradeTs === undefined) {
                const rawTs = trade.handleTimestamp ?? tradeProfit.timestamp;
                earliestTradeTs = Math.floor(rawTs / 1000);
            }

            totalRawKeys += tradeProfit.rawProfit.keys;
            totalRawMetal += tradeProfit.rawProfit.metal;

            if (tradeProfit.hasEstimates) {
                hasEstimates = true;
            }

            const tradeTime = trade.handleTimestamp || tradeProfit.timestamp;
            if (tradeTime && tradeTime >= twentyFourHoursAgo) {
                timedRawKeys += tradeProfit.rawProfit.keys;
                timedRawMetal += tradeProfit.rawProfit.metal;
            }
        }

        const timeSince =
            +bot.options.statistics.profitDataSinceInUnix === 0
                ? earliestTradeTs
                : +bot.options.statistics.profitDataSinceInUnix;

        resolve({
            rawProfit: { keys: totalRawKeys, metal: totalRawMetal },
            rawProfitTimed: { keys: timedRawKeys, metal: timedRawMetal },
            since: !timeSince ? 0 : now.diff(dayjs.unix(timeSince), 'day'),
            hasEstimates
        });
    });
}
