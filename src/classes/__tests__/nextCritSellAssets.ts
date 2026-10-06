import Currencies from '@tf2autobot/tf2-currencies';
import type Bot from '../Bot';
import type { Entry } from '../Pricelist';
import nextCritSellAssets from '../nextCritSellAssets';

const sku = '300;6';

function makeBot({
    ids = ['101', '102', '103'],
    limit = 3,
    entries = {},
    reserved = [],
    painted = false
}: {
    ids?: string[];
    limit?: number;
    entries?: Record<string, Partial<Entry>>;
    reserved?: string[];
    painted?: boolean;
} = {}): Bot {
    const prices: Record<string, Partial<Entry>> = {
        [sku]: { sku, enabled: true, intent: 1, sell: new Currencies({ keys: 1 }) },
        ...entries
    };
    return {
        pricelist: { getPrice: ({ priceKey }: { priceKey: string }) => prices[priceKey] ?? null },
        inventoryManager: {
            getInventory: { getItems: { [painted ? `${sku};p123` : sku]: ids.map(id => ({ id })) } },
            amountCanTrade: ({ priceKey }: { priceKey: string }) => (priceKey === sku ? limit : 1)
        },
        options: { normalize: { painted: { our: painted } }, miscSettings: { skipItemsInTrade: { enable: true } } },
        trades: { isInTrade: (id: string) => reserved.includes(id) }
    } as unknown as Bot;
}

test('lists every copy of a sellable item', () => {
    const assets = nextCritSellAssets(makeBot());
    expect(assets.map(asset => asset.assetId)).toEqual(['101', '102', '103']);
    expect(assets.every(asset => asset.currencies.keys === 1)).toBe(true);
});

test('respects sell limits with a stable selection across inventory order changes', () => {
    expect(nextCritSellAssets(makeBot({ ids: ['103', '101', '102'], limit: 2 })).map(asset => asset.assetId)).toEqual([
        '101',
        '102'
    ]);
    expect(nextCritSellAssets(makeBot({ limit: 0 }))).toEqual([]);
});

test('uses an individual asset price without also listing it under the SKU price', () => {
    const assets = nextCritSellAssets(
        makeBot({
            limit: 2,
            entries: { '102': { id: '102', sku, enabled: true, intent: 1, sell: new Currencies({ keys: 5 }) } }
        })
    );
    expect(assets.map(asset => [asset.assetId, asset.currencies.keys])).toEqual([
        ['101', 1],
        ['103', 1],
        ['102', 5]
    ]);
});

test('does not fall back to the SKU price for disabled or buy-only asset entries', () => {
    const assets = nextCritSellAssets(
        makeBot({
            entries: {
                '101': { id: '101', sku, enabled: false, intent: 1 },
                '102': { id: '102', sku, enabled: true, intent: 0 }
            }
        })
    );
    expect(assets.map(asset => asset.assetId)).toEqual(['103']);
});

test('does not publish disabled or buy-only SKU entries', () => {
    for (const entry of [
        { enabled: false, intent: 1 },
        { enabled: true, intent: 0 }
    ]) {
        expect(nextCritSellAssets(makeBot({ entries: { [sku]: entry as Partial<Entry> } }))).toEqual([]);
    }
});

test('skips reserved assets and allows them again when released', () => {
    expect(nextCritSellAssets(makeBot({ reserved: ['102'] })).map(asset => asset.assetId)).toEqual(['101', '103']);
    const bot = makeBot({ reserved: ['102'] });
    bot.options.miscSettings.skipItemsInTrade.enable = false;
    expect(nextCritSellAssets(bot).map(asset => asset.assetId)).toEqual(['101', '102', '103']);
});

test('uses the normalized paint price for every matching asset', () => {
    expect(nextCritSellAssets(makeBot({ painted: true })).map(asset => asset.assetId)).toEqual(['101', '102', '103']);
});

test('does not publish assets missing from the tradable inventory', () => {
    expect(nextCritSellAssets(makeBot({ ids: [] }))).toEqual([]);
});
