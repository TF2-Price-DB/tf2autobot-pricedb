import type Bot from '../Bot';
import type NextCritDriver from '../NextCritDriver';
import Listings from '../Listings';
import { NextCritRequestError } from '../NextCritDriver';
import log from '../../lib/logger';

jest.mock('../Bot', () => ({ __esModule: true, default: jest.fn() }));

function setup() {
    const listings = new Listings({
        options: {
            nextCritEnable: false,
            details: { buy: '', sell: '' },
            miscSettings: { createListings: { enable: true } }
        },
        inventoryManager: { getInventory: { getItems: {} } },
        pricelist: { getPrices: {} },
        client: { steamID: { getSteamID64: () => '76561198000000000' } }
    } as unknown as Bot);
    const internals = listings as unknown as {
        removeAllBackpackListings: () => Promise<void>;
        nextCrit: Pick<NextCritDriver, 'deleteAllListings'>;
    };
    const removeBackpack = jest.spyOn(internals, 'removeAllBackpackListings').mockResolvedValue(undefined);
    const checkAll = jest.spyOn(listings, 'checkAll').mockResolvedValue(undefined);
    return { listings, internals, removeBackpack, checkAll };
}

test('redoListings supports asCallback without NextCrit', async () => {
    const { listings, checkAll } = setup();
    const result = listings.redoListings();
    expect(typeof result.asCallback).toBe('function');
    await new Promise<void>((resolve, reject) => {
        void result.asCallback(err => (err ? reject(err) : resolve()));
    });
    expect(checkAll).toHaveBeenCalledTimes(1);
});

test('redoListings waits for both providers before checking listings and calling back', async () => {
    const { listings, internals, checkAll } = setup();
    let finishNextCrit: () => void;
    const deletion = new Promise<void>(resolve => {
        finishNextCrit = resolve;
    });
    internals.nextCrit = { deleteAllListings: jest.fn(() => deletion) };
    const result = listings.redoListings();
    expect(typeof result.asCallback).toBe('function');
    expect(checkAll).not.toHaveBeenCalled();
    finishNextCrit();
    await new Promise<void>((resolve, reject) => {
        void result.asCallback(err => (err ? reject(err) : resolve()));
    });
    expect(checkAll).toHaveBeenCalledTimes(1);
});

test('redoListings reports backpack removal failure through asCallback', async () => {
    const { listings, removeBackpack, checkAll } = setup();
    const failure = new Error('Deletion failed');
    removeBackpack.mockRejectedValue(failure);
    const result = listings.redoListings();
    const callbackError = await new Promise<Error>(resolve => {
        void result.asCallback(err => resolve(err as Error));
    });
    expect(callbackError).toBe(failure);
    expect(checkAll).not.toHaveBeenCalled();
});

test.each([new NextCritRequestError(undefined, 'ECONNABORTED'), new NextCritRequestError(503, undefined)])(
    'redoListings continues after a Crit TF outage: %s',
    async failure => {
        const { listings, internals, checkAll } = setup();
        const warning = jest.spyOn(log, 'warn').mockImplementation(() => log);
        internals.nextCrit = { deleteAllListings: jest.fn(() => Promise.reject(failure)) };
        try {
            await new Promise<void>((resolve, reject) => {
                void listings.redoListings().asCallback(err => (err ? reject(err) : resolve()));
            });
            expect(checkAll).toHaveBeenCalledTimes(1);
            expect(warning).toHaveBeenCalled();
        } finally {
            warning.mockRestore();
        }
    }
);

test('queues both listing intents before removal while the sell sync is pending', async () => {
    const { listings } = setup();
    const calls: string[] = [];
    let finishSell: () => void;
    const selling = new Promise<void>(resolve => {
        finishSell = resolve;
    });
    const internals = listings as unknown as {
        syncNextCritListings: () => Promise<void>;
        nextCrit: Pick<NextCritDriver, 'syncSellListings' | 'syncBuyListings' | 'deleteAllListings'>;
    };
    internals.nextCrit = {
        syncSellListings: jest.fn(() => {
            calls.push('sell');
            return selling;
        }),
        syncBuyListings: jest.fn(() => {
            calls.push('buy');
            return Promise.resolve();
        }),
        deleteAllListings: jest.fn(() => {
            calls.push('delete');
            return Promise.resolve();
        })
    };
    const sync = internals.syncNextCritListings();
    const removing = listings.removeAll();
    expect(calls).toEqual(['sell', 'buy', 'delete']);
    finishSell();
    await Promise.all([sync, removing]);
});
