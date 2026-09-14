import Currencies from '@tf2autobot/tf2-currencies';
import { ItemsDict, Prices } from '@tf2autobot/tradeoffer-manager';

// Rebuild every component together: saved totals may predate the current conversion rate.
export function counterOfferValue(
    dict: ItemsDict,
    prices: Prices,
    sellRate: number,
    weapons: string[],
    showOnlyMetal: boolean
): { our: { keys: number; scrap: number }; their: { keys: number; scrap: number } } {
    const metal = { '5000;6': 1, '5001;6': 3, '5002;6': 9 };
    const pureTrade = [dict.our, dict.their].every(side =>
        Object.keys(side).every(sku => sku === '5021;6' || metal[sku] !== undefined)
    );
    const result = { our: { keys: 0, scrap: 0 }, their: { keys: 0, scrap: 0 } };
    for (const side of ['our', 'their'] as const) {
        for (const [sku, amount] of Object.entries(dict[side])) {
            if (!amount) continue;
            if (metal[sku] !== undefined) {
                result[side].scrap += metal[sku] * amount;
            } else if (sku === '5021;6' && !pureTrade) {
                result[side].keys += amount;
            } else if (weapons.includes(sku) && prices[sku] === undefined) {
                // Incoming valuation leaves weapons used as currency out of the saved prices.
                result[side].scrap += 0.5 * amount;
            } else {
                const price = prices[sku]?.[side === 'our' ? 'sell' : 'buy'];
                if (!price) throw new Error(`Missing saved counteroffer price for ${side} ${sku}`);
                result[side].keys += price.keys * amount;
                result[side].scrap += Currencies.toScrap(price.metal) * amount;
            }
        }
        if (showOnlyMetal) {
            result[side].scrap += result[side].keys * Currencies.toScrap(sellRate);
            result[side].keys = 0;
        }
    }
    return result;
}
