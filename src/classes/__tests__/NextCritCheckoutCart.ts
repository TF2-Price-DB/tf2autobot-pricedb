import SteamID from 'steamid';
import Currencies from '../../lib/currencies';
import type Bot from '../Bot';
import type NextCritDriver from '../NextCritDriver';
import NextCritCheckoutCart from '../Carts/NextCritCheckoutCart';
import nextCritSellAssets from '../nextCritSellAssets';

const mockConstruct = jest.fn();
const mockPreSend = jest.fn();
const mockAddOurItem = jest.fn();
const mockOffer = { itemsToGive: [{ assetid: '101' }, { assetid: '102' }], data: jest.fn() };

jest.mock('../nextCritSellAssets');
jest.mock('../Carts/UserCart', () => ({
    __esModule: true,
    default: class {
        partner: SteamID;

        bot: Bot;

        offer = mockOffer;

        constructor(partner: SteamID, _token: string, bot: Bot) {
            this.partner = partner;
            this.bot = bot;
        }

        addOurItem = mockAddOurItem;

        constructOffer(): Promise<string> {
            return mockConstruct() as Promise<string>;
        }

        preSendOffer(): Promise<void> {
            return mockPreSend() as Promise<void>;
        }
    }
}));

function setup() {
    const bot = {
        isReady: true,
        isHalted: false,
        botManager: { isStopping: false },
        craftWeapons: [],
        uncraftWeapons: [],
        trades: { isInTrade: jest.fn(() => false), getActiveOffer: jest.fn(() => null) }
    } as unknown as Bot;
    const getListings = jest.fn().mockResolvedValue(
        ['101', '102'].map(asset_id => ({
            asset_id,
            price: { keys: 1, half_scrap: 2 }
        }))
    );
    const cart = new NextCritCheckoutCart(
        new SteamID('76561198000000001'),
        'token',
        bot,
        { getListings } as unknown as NextCritDriver,
        ['101', '102']
    );
    const preSend = () => (cart as unknown as { preSendOffer: () => Promise<void> }).preSendOffer();
    return { bot, cart, getListings, preSend };
}

beforeEach(() => {
    jest.resetAllMocks();
    mockConstruct.mockResolvedValue(undefined);
    mockPreSend.mockResolvedValue(undefined);
    mockOffer.itemsToGive = [{ assetid: '101' }, { assetid: '102' }];
    jest.mocked(nextCritSellAssets).mockReturnValue(
        ['101', '102'].map(assetId => ({
            assetId,
            currencies: new Currencies({ keys: 1, metal: 0.11 })
        }))
    );
});

test('builds the normal user cart with exact asset IDs and delegates pre-send checks', async () => {
    const { cart, preSend } = setup();
    expect(mockAddOurItem.mock.calls).toEqual([['101'], ['102']]);
    await cart.constructOffer();
    await preSend();
    expect(mockConstruct).toHaveBeenCalledTimes(1);
    expect(mockPreSend).toHaveBeenCalledTimes(1);
    expect(mockOffer.data).toHaveBeenCalledWith('nextCritCheckout', true);
});

test('rejects a changed advertised price before constructing an offer', async () => {
    const { cart, getListings } = setup();
    getListings.mockResolvedValue([
        { asset_id: '101', price: { keys: 2, half_scrap: 2 } },
        { asset_id: '102', price: { keys: 1, half_scrap: 2 } }
    ]);
    await expect(cart.constructOffer()).rejects.toThrow('price has changed');
    expect(mockConstruct).not.toHaveBeenCalled();
});

test('rejects removed server listings', async () => {
    const { cart, getListings } = setup();
    getListings.mockResolvedValue([]);
    await expect(cart.constructOffer()).rejects.toThrow('no longer available');
});

test('rejects partial quantities and substituted assets', async () => {
    const { cart } = setup();
    mockConstruct.mockResolvedValue('Only one remains');
    await expect(cart.constructOffer()).rejects.toThrow('requested quantity');
    mockConstruct.mockResolvedValue(undefined);
    mockOffer.itemsToGive = [{ assetid: '101' }, { assetid: '103' }];
    await expect(cart.constructOffer()).rejects.toThrow('missing a requested asset');
});

test.each(['stock', 'price', 'reservation'])('rechecks %s after the reputation checks', async change => {
    const { cart, bot, preSend } = setup();
    await cart.constructOffer();
    mockPreSend.mockImplementation(() => {
        if (change === 'stock') jest.mocked(nextCritSellAssets).mockReturnValue([]);
        if (change === 'price') {
            jest.mocked(nextCritSellAssets).mockReturnValue(
                ['101', '102'].map(assetId => ({
                    assetId,
                    currencies: new Currencies({ keys: 2, metal: 0.11 })
                }))
            );
        }
        if (change === 'reservation') {
            mockOffer.itemsToGive.push({ assetid: 'change' });
            jest.spyOn(bot.trades, 'isInTrade').mockImplementation(id => id === 'change');
        }
        return Promise.resolve();
    });
    await expect(preSend()).rejects.toThrow(
        change === 'stock' ? 'no longer sellable' : change === 'price' ? 'price has changed' : 'already reserved'
    );
});

test('refuses queued checkout after halt or shutdown', async () => {
    const { cart, bot } = setup();
    Object.assign(bot.botManager, { isStopping: true });
    await expect(cart.constructOffer()).rejects.toThrow('bot is stopped');
    expect(mockConstruct).not.toHaveBeenCalled();
});
