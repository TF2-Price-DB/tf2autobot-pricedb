import Currencies from '@tf2autobot/tf2-currencies';
import { ItemsDict, Prices } from '@tf2autobot/tradeoffer-manager';

const metal: Record<string, number> = { '5000;6': 1, '5001;6': 3, '5002;6': 9 };

function counterOfferItemValue(
    sku: string,
    side: 'our' | 'their',
    prices: Prices,
    pureTrade: boolean,
    weapons: string[]
): { keys: number; scrap: number } {
    if (metal[sku] !== undefined) return { keys: 0, scrap: metal[sku] };
    if (sku === '5021;6' && !pureTrade) return { keys: 1, scrap: 0 };
    if (weapons.includes(sku) && prices[sku] === undefined) {
        // Incoming valuation leaves weapons used as currency out of the saved prices.
        return { keys: 0, scrap: 0.5 };
    }

    const price = prices[sku]?.[side === 'our' ? 'sell' : 'buy'];
    if (!price) throw new Error(`Missing saved counteroffer price for ${side} ${sku}`);
    return { keys: price.keys, scrap: Currencies.toScrap(price.metal) };
}

// Rebuild every component together: saved totals may predate the current conversion rate.
export function counterOfferValue(
    dict: ItemsDict,
    prices: Prices,
    sellRate: number,
    weapons: string[],
    showOnlyMetal: boolean
): { our: { keys: number; scrap: number }; their: { keys: number; scrap: number } } {
    const pureTrade = [dict.our, dict.their].every(side =>
        Object.keys(side).every(sku => sku === '5021;6' || metal[sku] !== undefined)
    );
    const result = { our: { keys: 0, scrap: 0 }, their: { keys: 0, scrap: 0 } };
    for (const side of ['our', 'their'] as const) {
        for (const [sku, amount] of Object.entries(dict[side])) {
            if (!amount) continue;
            const value = counterOfferItemValue(sku, side, prices, pureTrade, weapons);
            result[side].keys += value.keys * amount;
            result[side].scrap += value.scrap * amount;
        }
        if (showOnlyMetal) {
            result[side].scrap += result[side].keys * Currencies.toScrap(sellRate);
            result[side].keys = 0;
        }
    }
    return result;
}
