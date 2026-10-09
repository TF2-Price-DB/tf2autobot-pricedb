import SteamID from 'steamid';
import Currencies from '../../lib/currencies';
import type Bot from '../Bot';
import type NextCritDriver from '../NextCritDriver';
import NextCritBuyCheckoutCart from '../Carts/NextCritBuyCheckoutCart';
import { nextCritBuyListingEntries } from '../nextCritBuyListings';

const mockConstruct = jest.fn();
const mockPreSend = jest.fn();
const mockAddTheirItem = jest.fn();
const mockOffer = { itemsToGive: [{ assetid: 'payment' }], itemsToReceive: [{ assetid: '101' }], data: jest.fn() };
const listing = {
    id: 2,
    hat: 'Z^Rocket_Launcher;TC;Unique',
    ignored_fields: [],
    price: { keys: 1, half_scrap: 2 },
    amount: 3
};

jest.mock('../nextCritBuyListings');
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

        addTheirItem = mockAddTheirItem;

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
        manager: { pollData: { sent: {}, received: {}, offerData: {} } },
        trades: {
            isInTrade: jest.fn(() => false),
            getActiveOffer: jest.fn(() => null),
            getActiveOffers: jest.fn(() => ({ sent: [], received: [] }))
        }
    } as unknown as Bot;
    const getBuyListings = jest.fn().mockResolvedValue([listing]);
    const cart = new NextCritBuyCheckoutCart(
        new SteamID('76561198000000001'),
        'token',
        bot,
        { getBuyListings } as unknown as NextCritDriver,
        2,
        1
    );
    const preSend = () => (cart as unknown as { preSendOffer: () => Promise<void> }).preSendOffer();
    return { bot, cart, getBuyListings, preSend };
}

beforeEach(() => {
    jest.resetAllMocks();
    mockConstruct.mockResolvedValue(undefined);
    mockPreSend.mockResolvedValue(undefined);
    mockOffer.itemsToReceive = [{ assetid: '101' }];
    mockOffer.data.mockImplementation((key: string) => {
        if (key === 'dict') return { our: {}, their: { '205;6': 1 } };
        if (key === 'prices') return { '205;6': { buy: new Currencies({ keys: 1, metal: 0.11 }) } };
    });
    jest.mocked(nextCritBuyListingEntries).mockReturnValue([{ sku: '205;6', listing: { ...listing } }]);
});

test('resolves the order to a buy SKU and delegates construction and pre-send checks', async () => {
    const { cart, preSend } = setup();
    await cart.constructOffer();
    await preSend();
    expect(mockAddTheirItem).toHaveBeenCalledWith('205;6', 1);
    expect(mockConstruct).toHaveBeenCalledTimes(1);
    expect(mockPreSend).toHaveBeenCalledTimes(1);
    expect(mockOffer.data).toHaveBeenCalledWith('nextCritCheckout', true);
});

test('rejects a removed buy order before construction', async () => {
    const { cart, getBuyListings } = setup();
    getBuyListings.mockResolvedValue([]);
    await expect(cart.constructOffer()).rejects.toThrow('no longer available');
    expect(mockConstruct).not.toHaveBeenCalled();
});

test.each(['missing', 'ambiguous', 'price', 'quantity'])('rejects changed buy criteria: %s', async change => {
    const { cart } = setup();
    const entries = [{ sku: '205;6', listing: { ...listing } }];
    if (change === 'missing') entries.length = 0;
    if (change === 'ambiguous') entries.push({ ...entries[0], sku: 'other' });
    if (change === 'price') entries[0].listing.price = { keys: 2, half_scrap: 2 };
    if (change === 'quantity') entries[0].listing.amount = 0;
    jest.mocked(nextCritBuyListingEntries).mockReturnValue(entries);
    await expect(cart.constructOffer()).rejects.toThrow();
    expect(mockConstruct).not.toHaveBeenCalled();
});

test('pending purchases consume the remaining stock budget', async () => {
    const { cart, bot } = setup();
    jest.spyOn(bot.trades, 'getActiveOffers').mockReturnValue({ sent: ['pending'], received: [] });
    bot.manager.pollData.offerData.pending = { dict: { our: {}, their: { '205;6': 3 } } };
    await expect(cart.constructOffer()).rejects.toThrow('stock limit');
});

test.each(['quantity', 'price', 'payment', 'halt'])('rechecks %s after reputation and escrow', async change => {
    const { cart, bot, preSend } = setup();
    await cart.constructOffer();
    mockPreSend.mockImplementation(() => {
        if (change === 'quantity') mockOffer.itemsToReceive = [];
        if (change === 'price')
            jest.mocked(nextCritBuyListingEntries).mockReturnValue([
                { sku: '205;6', listing: { ...listing, price: { keys: 2, half_scrap: 2 } } }
            ]);
        if (change === 'payment') jest.spyOn(bot.trades, 'isInTrade').mockReturnValue(true);
        if (change === 'halt') Object.assign(bot, { isHalted: true });
        return Promise.resolve();
    });
    await expect(preSend()).rejects.toThrow();
});

test('rejects an offer priced differently during construction', async () => {
    const { cart } = setup();
    mockConstruct.mockImplementation(() => {
        mockOffer.data.mockImplementation((key: string) =>
            key === 'dict' ? { their: { '205;6': 1 } } : { '205;6': { buy: new Currencies({ keys: 2 }) } }
        );
        return Promise.resolve();
    });
    await expect(cart.constructOffer()).rejects.toThrow('offer buy price has changed');
});

test('rejects partial fulfillment and normal cart payment failures', async () => {
    const { cart } = setup();
    mockConstruct.mockResolvedValue('Only zero remain');
    await expect(cart.constructOffer()).rejects.toThrow('requested quantity');
    mockConstruct.mockRejectedValue(new Error('Not enough pure'));
    await expect(cart.constructOffer()).rejects.toThrow('Not enough pure');
});
