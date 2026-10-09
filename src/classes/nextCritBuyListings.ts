import SKU from '@tf2autobot/tf2-sku';
import type Bot from './Bot';
import NextCritDriver, { NextCritBuyInput, NextCritIgnoredField } from './NextCritDriver';
import { createHatVersionZ, HatVersionZProps } from '../vendor/the-future/createHat';

/** Build buy criteria from the schema, including items absent from our inventory. */
export default function nextCritBuyListings(bot: Bot): NextCritBuyInput[] {
    return nextCritBuyListingEntries(bot).map(entry => entry.listing);
}

export function nextCritBuyListingEntries(bot: Bot): { sku: string; listing: NextCritBuyInput }[] {
    const listings: { sku: string; listing: NextCritBuyInput }[] = [];
    for (const [priceKey, entry] of Object.entries(bot.pricelist.getPrices)) {
        if (!entry.enabled || entry.id || entry.intent === 1 || !entry.buy) continue;
        const capacity = bot.inventoryManager.amountCanTrade({ priceKey, tradeIntent: 'buying' });
        if (capacity <= 0) continue;
        if (
            bot.options.pricelist.filterCantAfford.enable &&
            !bot.inventoryManager.isCanAffordToBuy(entry.buy, bot.inventoryManager.getInventory)
        )
            continue;
        const item = SKU.fromString(entry.sku);
        // HAT Version Z cannot express a specific craft number.
        if (item.craftnumber) continue;
        const nameItem = { ...item, craftnumber: null };
        // Steam market names omit craftability, paint and the individual unusual effect.
        const marketHashName = bot.schema.getName(nameItem, false, false, true)?.replace(/%23/g, '#');
        const quality = bot.schema.getQualityById(item.quality);
        if (!marketHashName || !quality) throw new Error(`Cannot build NextCrit buy criteria for ${entry.sku}`);
        const lookup = (id: number, getName: (id: number) => string | null): string[] => {
            if (id === null || id === undefined) return [];
            const name = getName(id);
            if (!name) throw new Error(`Cannot resolve NextCrit buy attribute for ${entry.sku}`);
            return [name];
        };
        const props: HatVersionZProps = {
            marketHashName,
            tradable: item.tradable !== false,
            marketable: false,
            craftable: item.craftable,
            festivized: item.festive,
            loaner: false,
            qualities: [quality],
            unusualEffects: lookup(item.effect || null, id => bot.schema.getEffectById(id)),
            killstreakers: [],
            sheens: [],
            warPaints: lookup(item.paintkit, id => {
                const name = bot.schema.getSkinById(id);
                return name ? `${name} War Paint` : null;
            }),
            paints: lookup(item.paint || null, id => bot.schema.getPaintNameByDecimal(id)),
            strangeParts: [],
            strangeFilters: [],
            spells: []
        };
        const ignored: NextCritIgnoredField[] = [
            'marketability',
            'killstreaker',
            'sheen',
            'strange_parts',
            'strange_filters',
            'spells'
        ];
        if (bot.options.normalize.painted.their && !item.paint) ignored.push('paint');
        if (bot.options.normalize.festivized.their && !item.festive) ignored.push('festivized');
        if (item.quality === 5 && !item.effect) ignored.push('unusual_effect');
        listings.push({
            sku: entry.sku,
            listing: {
                hat: `Z^${createHatVersionZ(props)}`,
                ignored_fields: ignored,
                price: NextCritDriver.toPrice(entry.buy),
                // Represent unlimited stock as a finite JSON quantity; leave finite widths to NextCrit.
                amount: capacity === Infinity ? 65535 : capacity
            }
        });
    }
    return listings;
}
