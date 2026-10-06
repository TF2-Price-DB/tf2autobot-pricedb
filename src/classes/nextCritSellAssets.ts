import type Bot from './Bot';
import type { Entry } from './Pricelist';
import type { NextCritSellAsset } from './NextCritDriver';

/** Select every tradable asset covered by an enabled sell entry, up to its stock limit. */
export default function nextCritSellAssets(bot: Bot): NextCritSellAsset[] {
    const groups = new Map<string, { entry: Entry; assetIds: string[] }>();
    for (const [sku, items] of Object.entries(bot.inventoryManager.getInventory.getItems)) {
        for (const item of items) {
            const assetEntry = bot.pricelist.getPrice({ priceKey: item.id, onlyEnabled: false });
            const entry =
                assetEntry ??
                bot.pricelist.getPrice({ priceKey: sku, onlyEnabled: false }) ??
                (bot.options.normalize.painted.our
                    ? bot.pricelist.getPrice({ priceKey: sku.replace(/;p\d+/, ''), onlyEnabled: false })
                    : null);
            if (!entry?.enabled || (entry.intent !== 1 && entry.intent !== 2)) continue;
            const priceKey = entry.id ?? entry.sku;
            let group = groups.get(priceKey);
            if (!group) {
                group = { entry, assetIds: [] };
                groups.set(priceKey, group);
            }
            if (bot.options.miscSettings.skipItemsInTrade.enable && bot.trades.isInTrade(item.id)) continue;
            group.assetIds.push(item.id);
        }
    }

    const assets: NextCritSellAsset[] = [];
    for (const [priceKey, { entry, assetIds }] of groups) {
        const amountCanSell = bot.inventoryManager.amountCanTrade({ priceKey, tradeIntent: 'selling' });
        // Keep the selection stable as inventory ordering changes, preserving stock reserved by min.
        assetIds.sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
        for (const assetId of assetIds.slice(0, amountCanSell)) {
            assets.push({ assetId, currencies: entry.sell });
        }
    }
    return assets;
}
