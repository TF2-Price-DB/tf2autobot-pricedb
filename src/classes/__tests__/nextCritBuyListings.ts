import Currencies from '@tf2autobot/tf2-currencies';
import SKU from '@tf2autobot/tf2-sku';
import SchemaManager from '@tf2autobot/tf2-schema';
import type Bot from '../Bot';
import nextCritBuyListings from '../nextCritBuyListings';
import { unparseHatVersionZ, createHatVersionZProps, createHatVersionZ } from '../../vendor/the-future/createHat';

function makeBot(sku = '205;6', capacity = 3): Bot {
    return {
        pricelist: {
            getPrices: { [sku]: { sku, enabled: true, intent: 0, buy: new Currencies({ keys: 1, metal: 0.11 }) } }
        },
        inventoryManager: {
            getInventory: { getItems: {} },
            amountCanTrade: jest.fn(() => capacity),
            isCanAffordToBuy: jest.fn(() => true)
        },
        schema: {
            getName: jest.fn(
                (item: ReturnType<typeof SKU.fromString>) =>
                    `${item.quality2 ? 'Strange ' : ''}${item.quality === 5 ? 'Unusual ' : ''}${
                        item.festive ? 'Festivized ' : ''
                    }Rocket Launcher`
            ),
            getQualityById: (id: number) => ({ 6: 'Unique', 5: 'Unusual' }[id]),
            getEffectById: () => 'Burning Flames',
            getPaintNameByDecimal: () => 'After Eight',
            getSkinById: () => 'Hana'
        },
        options: {
            pricelist: { filterCantAfford: { enable: false } },
            normalize: { painted: { their: true }, festivized: { their: false } }
        }
    } as unknown as Bot;
}

test('lists absent inventory items using buy prices and available stock', () => {
    const bot = makeBot();
    expect(nextCritBuyListings(bot)).toEqual([
        {
            hat: 'Z^Rocket_Launcher;TC;Unique',
            ignored_fields: [
                'marketability',
                'killstreaker',
                'sheen',
                'strange_parts',
                'strange_filters',
                'spells',
                'paint'
            ],
            price: { keys: 1, half_scrap: 2 },
            amount: 3
        }
    ]);
    // The schema method is a Jest mock; no unbound invocation occurs.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(bot.schema.getName).toHaveBeenCalledWith(expect.objectContaining({ defindex: 205 }), false, false, true);
});

test.each([0, -1])('withdraws buys when capacity is %s', capacity => {
    expect(nextCritBuyListings(makeBot('205;6', capacity))).toEqual([]);
});

test('represents unlimited stock as a finite JSON quantity', () => {
    expect(nextCritBuyListings(makeBot('205;6', Infinity))[0].amount).toBe(65535);
});

test('leaves finite quantity widths to NextCrit', () => {
    expect(nextCritBuyListings(makeBot('205;6', 70000))[0].amount).toBe(70000);
});

test.each([{ enabled: false }, { intent: 1 }, { id: '123' }, { buy: null }])('skips ineligible entries %s', changes => {
    const bot = makeBot();
    Object.assign(bot.pricelist.getPrices['205;6'], changes);
    expect(nextCritBuyListings(bot)).toEqual([]);
});

test('respects affordability filtering and bank entries', () => {
    const bot = makeBot();
    bot.pricelist.getPrices['205;6'].intent = 2;
    expect(nextCritBuyListings(bot)).toHaveLength(1);
    bot.options.pricelist.filterCantAfford.enable = true;
    jest.spyOn(bot.inventoryManager, 'isCanAffordToBuy').mockReturnValue(false);
    expect(nextCritBuyListings(bot)).toEqual([]);
});

test('preserves effect, secondary quality, craftability and specific paint', () => {
    const listing = nextCritBuyListings(makeBot('205;5;uncraftable;u13;strange;p123'))[0];
    const props = unparseHatVersionZ(listing.hat.slice(2));
    expect(props.marketHashName).toBe('Strange Unusual Rocket Launcher');
    expect(props.qualities).toEqual(['Unusual']);
    expect(props.unusualEffects).toEqual(['Burning Flames']);
    expect(props.paints).toEqual(['After Eight']);
    expect(props.craftable).toBe(false);
    expect(listing.ignored_fields).not.toContain('paint');
    expect(listing.ignored_fields).not.toContain('unusual_effect');
});

test('allows any effect for a generic unusual entry and normalized festivized items', () => {
    const bot = makeBot('205;5');
    bot.options.normalize.festivized.their = true;
    const listing = nextCritBuyListings(bot)[0];
    expect(listing.ignored_fields).toEqual(expect.arrayContaining(['unusual_effect', 'festivized']));
});

test('keeps explicitly festivized criteria even when normalization is enabled', () => {
    const bot = makeBot('205;6;festive');
    bot.options.normalize.festivized.their = true;
    expect(nextCritBuyListings(bot)[0].ignored_fields).not.toContain('festivized');
});

test('uses vendored serialization consistently for schema criteria and inventory descriptions', () => {
    const fromInventory = createHatVersionZ(
        createHatVersionZProps({
            market_hash_name: 'Rocket Launcher',
            tradable: 1,
            marketable: 0,
            tags: [{ category: 'Quality', localized_tag_name: 'Unique' }],
            descriptions: []
        })
    );
    expect(nextCritBuyListings(makeBot())[0].hat).toBe(`Z^${fromInventory}`);
});

test('uses schema market naming for killstreak skins while preserving separate HAT fields', () => {
    const bot = makeBot('205;15;kt-3;pk42;w3');
    bot.schema.getItemByDefindex = jest.fn().mockReturnValue({ item_name: 'Rocket Launcher', item_quality: 6 });
    bot.schema.getQualityById = id => (id === 15 ? 'Decorated Weapon' : 'Unique');
    bot.schema.getName = SchemaManager.Schema.prototype.getName.bind(bot.schema);
    const props = unparseHatVersionZ(nextCritBuyListings(bot)[0].hat.slice(2));
    expect(props.marketHashName).toBe('Professional Killstreak Hana Rocket Launcher (Field-Tested)');
    expect(props.qualities).toEqual(['Decorated Weapon']);
    expect(props.warPaints).toEqual(['Hana War Paint']);
});

test('skips specific craft numbers that HAT cannot express', () => {
    expect(nextCritBuyListings(makeBot('205;6;n42'))).toEqual([]);
});
