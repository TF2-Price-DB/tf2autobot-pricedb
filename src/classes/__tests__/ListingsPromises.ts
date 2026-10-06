import type Bot from '../Bot';
import type NextCritDriver from '../NextCritDriver';
import Listings from '../Listings';

jest.mock('../Bot', () => ({ __esModule: true, default: jest.fn() }));

function setup() {
    const listings = new Listings({
        options: { nextCritEnable: false, details: { buy: '', sell: '' } }
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

test.each(['backpack', 'nextcrit'])('redoListings reports %s removal failure through asCallback', async provider => {
    const { listings, internals, removeBackpack, checkAll } = setup();
    const failure = new Error('Deletion failed');
    if (provider === 'backpack') {
        removeBackpack.mockRejectedValue(failure);
    } else {
        internals.nextCrit = { deleteAllListings: jest.fn(() => Promise.reject(failure)) };
    }
    const result = listings.redoListings();
    const callbackError = await new Promise<Error>(resolve => {
        void result.asCallback(err => resolve(err as Error));
    });
    expect(callbackError).toBe(failure);
    expect(checkAll).not.toHaveBeenCalled();
});
