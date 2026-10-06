import axios, { AxiosError, AxiosRequestConfig } from 'axios';
import { Agent } from 'https';
import Currencies from '@tf2autobot/tf2-currencies';
import NextCritDriver, { NextCritRequestError } from '../NextCritDriver';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;
const post = jest.fn();
const request = jest.fn();

beforeEach(() => {
    jest.resetAllMocks();
    mockedAxios.create.mockReturnValue({ post, request } as unknown as ReturnType<typeof axios.create>);
    mockedAxios.isAxiosError.mockImplementation(
        (error: unknown): error is AxiosError =>
            typeof error === 'object' && error !== null && 'isAxiosError' in error && error.isAxiosError === true
    );
    post.mockResolvedValue({ data: { token: 'short-lived-token' } });
    request.mockResolvedValue({ data: { success: true, listings: [] } });
});

test.each([
    [0, 0],
    [0.05, 1],
    [0.11, 2],
    [0.33, 6],
    [1, 18],
    [1.55, 28]
])('converts %s refined to %s half-scrap', (metal, halfScrap) => {
    expect(NextCritDriver.toPrice(new Currencies({ keys: 2, metal }))).toEqual({ keys: 2, half_scrap: halfScrap });
});

test('rejects invalid prices', () => {
    for (const price of [
        { keys: -1, metal: 0 },
        { keys: 0.5, metal: 0 },
        { keys: 0, metal: -0.01 },
        { keys: 0, metal: Infinity }
    ]) {
        expect(() => NextCritDriver.toPrice(price as Currencies)).toThrow('Invalid NextCrit sell-listing price');
    }
});

test('authenticates with the API key and publishes with the short-lived token', async () => {
    const driver = new NextCritDriver('long-lived-key');
    await driver.createOrUpdateListing('12345678901234567', new Currencies({ keys: 2, metal: 0.11 }));
    expect(post).toHaveBeenCalledWith('/api/v2/auth', undefined, { headers: { 'X-API-KEY': 'long-lived-key' } });
    expect(request).toHaveBeenCalledWith({
        method: 'POST',
        url: '/api/v2/sell-listings',
        data: [{ asset_id: '12345678901234567', price: { keys: 2, half_scrap: 2 } }],
        headers: { Authorization: 'Bearer short-lived-token' }
    });
});

test('skips unchanged successful publishes and sends changed prices', async () => {
    const driver = new NextCritDriver('key');
    await driver.createOrUpdateListing('123', new Currencies({ keys: 1 }));
    await driver.createOrUpdateListing('123', new Currencies({ keys: 1 }));
    await driver.createOrUpdateListing('123', new Currencies({ keys: 2 }));
    expect(request).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenCalledTimes(1);
});

test('renews expired tokens and retries an unauthorized request once', async () => {
    const driver = new NextCritDriver('key');
    request.mockRejectedValueOnce({ isAxiosError: true, response: { status: 401 } });
    post.mockResolvedValueOnce({ data: { token: 'old' } }).mockResolvedValueOnce({ data: { token: 'new' } });
    await driver.deleteListing('123');
    expect(post).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ headers: { Authorization: 'Bearer new' } }));
});

test('renews proactively after fourteen minutes', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1000000);
    try {
        const driver = new NextCritDriver('key');
        await driver.getListings();
        now.mockReturnValue(1000000 + 14 * 60 * 1000);
        await driver.getListings();
        expect(post).toHaveBeenCalledTimes(2);
    } finally {
        now.mockRestore();
    }
});

test('deletes only the selected asset and clears published state when deleting all', async () => {
    const driver = new NextCritDriver('key');
    const currencies = new Currencies({ keys: 1 });
    await driver.createOrUpdateListing('123', currencies);
    await driver.deleteListing('123');
    expect(request).toHaveBeenLastCalledWith(
        expect.objectContaining({
            method: 'DELETE',
            url: '/api/v2/sell-listings',
            params: { asset_ids: '123' }
        })
    );
    await driver.createOrUpdateListing('123', currencies);
    await driver.deleteAllListings();
    expect(request).toHaveBeenLastCalledWith(
        expect.objectContaining({ method: 'DELETE', url: '/api/v2/sell-listings/my' })
    );
    await driver.createOrUpdateListing('123', currencies);
    expect(request).toHaveBeenCalledTimes(5);
});

test('preserves publish/delete ordering even while authentication is pending', async () => {
    let authenticate: (value: { data: { token: string } }) => void;
    post.mockImplementationOnce(
        () =>
            new Promise(resolve => {
                authenticate = resolve;
            })
    );
    const driver = new NextCritDriver('key');
    const publish = driver.createOrUpdateListing('123', new Currencies({ keys: 1 }));
    const remove = driver.deleteListing('123');
    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
    authenticate({ data: { token: 'token' } });
    await Promise.all([publish, remove]);
    expect(request.mock.calls.map(([config]) => (config as AxiosRequestConfig).method)).toEqual(['POST', 'DELETE']);
});

test('failed writes can be retried and do not block subsequent operations or expose credentials', async () => {
    const driver = new NextCritDriver('secret-key');
    request.mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 404 },
        config: { headers: { Authorization: 'secret-token' } }
    });
    await expect(driver.createOrUpdateListing('123', new Currencies({ keys: 1 }))).rejects.toEqual(
        new NextCritRequestError(404, undefined)
    );
    await driver.createOrUpdateListing('123', new Currencies({ keys: 1 }));
    expect(request).toHaveBeenCalledTimes(2);
});

test('does not retry authentication failures indefinitely or leak the API key', async () => {
    post.mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 401 },
        config: { headers: { 'X-API-KEY': 'secret-key' } }
    });
    await expect(new NextCritDriver('secret-key').getListings()).rejects.toThrow('NextCrit request failed (401)');
    expect(post).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
});

test('refreshes the inventory at most once per minute', async () => {
    const driver = new NextCritDriver('key');
    await driver.refreshInventory('76561198000000000');
    await driver.refreshInventory('76561198000000000');
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'GET', url: '/api/v2/inventories/76561198000000000/0/refresh' })
    );
});

test('preserves the HAT returned by NextCrit', async () => {
    const listing = { asset_id: '123', hat: 'Z^The_Man_in_Slacks;TC;Unique', price: { keys: 1, half_scrap: 0 } };
    request.mockResolvedValueOnce({ data: { success: true, listings: [listing] } });
    await expect(new NextCritDriver('key').getListings()).resolves.toEqual([listing]);
});

test('rejects malformed asset IDs before making requests', () => {
    const driver = new NextCritDriver('key');
    for (const assetId of ['0', '-1', '1,2', '440_123']) {
        expect(() => driver.deleteListing(assetId)).toThrow('Invalid NextCrit asset ID');
    }
    expect(request).not.toHaveBeenCalled();
});

test('finishes inventory refresh and republish before a queued deletion', async () => {
    request.mockRejectedValueOnce({ isAxiosError: true, response: { status: 404 } });
    const driver = new NextCritDriver('key');
    const publish = driver.createOrUpdateListing('123', new Currencies({ keys: 1 }), '76561198000000000');
    const remove = driver.deleteListing('123');
    await Promise.all([publish, remove]);
    expect(request.mock.calls.map(([config]) => (config as AxiosRequestConfig).method)).toEqual([
        'POST',
        'GET',
        'POST',
        'DELETE'
    ]);
});

test('failed publish responses are not cached', async () => {
    request.mockResolvedValueOnce({ data: { success: false } });
    const driver = new NextCritDriver('key');
    await expect(driver.createOrUpdateListing('123', new Currencies({ keys: 1 }))).rejects.toThrow('did not publish');
    await driver.createOrUpdateListing('123', new Currencies({ keys: 1 }));
    expect(request).toHaveBeenCalledTimes(2);
});

test('uses the NextCrit URL supplied by dev', () => {
    new NextCritDriver('key');
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mockedAxios.create).toHaveBeenCalledWith(expect.objectContaining({ baseURL: 'https://next.crittf.tf' }));
});

test('limits self-signed certificate support to the NextCrit HTTPS agent', () => {
    new NextCritDriver('key');
    const strictAgent = mockedAxios.create.mock.calls[0][0].httpsAgent as Agent;
    expect(strictAgent.options.rejectUnauthorized).toBe(true);
    new NextCritDriver('key', undefined, true);
    const selfSignedAgent = mockedAxios.create.mock.calls[1][0].httpsAgent as Agent;
    expect(selfSignedAgent.options.rejectUnauthorized).toBe(false);
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
});

test('publishes every desired asset in a single batch', async () => {
    const driver = new NextCritDriver('key');
    await driver.syncSellListings(
        ['101', '102', '103'].map(assetId => ({ assetId, currencies: new Currencies({ keys: 1 }) })),
        '76561198000000000'
    );
    expect(request).toHaveBeenLastCalledWith(
        expect.objectContaining({
            method: 'POST',
            data: ['101', '102', '103'].map(asset_id => ({ asset_id, price: { keys: 1, half_scrap: 0 } }))
        })
    );
    expect(request).toHaveBeenCalledTimes(2);
});

test('reconciles sold assets, changed prices, and additional copies from remote state', async () => {
    request.mockResolvedValueOnce({
        data: {
            success: true,
            listings: [
                { asset_id: '101', price: { keys: 1, half_scrap: 0 } },
                { asset_id: '102', price: { keys: 1, half_scrap: 0 } },
                { asset_id: '199', price: { keys: 1, half_scrap: 0 } }
            ]
        }
    });
    const driver = new NextCritDriver('key');
    await driver.syncSellListings(
        [
            { assetId: '101', currencies: new Currencies({ keys: 1 }) },
            { assetId: '102', currencies: new Currencies({ keys: 2 }) },
            { assetId: '103', currencies: new Currencies({ keys: 1 }) }
        ],
        '76561198000000000'
    );
    expect(request).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ method: 'DELETE', params: { asset_ids: '199' } })
    );
    expect(request).toHaveBeenLastCalledWith(
        expect.objectContaining({
            method: 'POST',
            data: [
                { asset_id: '102', price: { keys: 2, half_scrap: 0 } },
                { asset_id: '103', price: { keys: 1, half_scrap: 0 } }
            ]
        })
    );
});

test('withdraws all remote listings when no assets are eligible, including after a restart', async () => {
    request.mockResolvedValueOnce({
        data: {
            success: true,
            listings: [
                { asset_id: '101', price: { keys: 1, half_scrap: 0 } },
                { asset_id: '102', price: { keys: 1, half_scrap: 0 } }
            ]
        }
    });
    await new NextCritDriver('key').syncSellListings([], '76561198000000000');
    expect(request).toHaveBeenLastCalledWith(
        expect.objectContaining({ method: 'DELETE', params: { asset_ids: '101,102' } })
    );
    expect(request).toHaveBeenCalledTimes(2);
});

test('avoids writes when every remote asset already has the correct price', async () => {
    request.mockResolvedValueOnce({
        data: { success: true, listings: [{ asset_id: '101', price: { keys: 1, half_scrap: 0 } }] }
    });
    await new NextCritDriver('key').syncSellListings(
        [{ assetId: '101', currencies: new Currencies({ keys: 1 }) }],
        '76561198000000000'
    );
    expect(request).toHaveBeenCalledTimes(1);
});

test('refreshes and retries the whole batch before clearing listings on halt', async () => {
    request
        .mockResolvedValueOnce({ data: { success: true, listings: [] } })
        .mockRejectedValueOnce({ isAxiosError: true, response: { status: 404 } });
    const driver = new NextCritDriver('key');
    const sync = driver.syncSellListings(
        ['101', '102'].map(assetId => ({ assetId, currencies: new Currencies({ keys: 1 }) })),
        '76561198000000000'
    );
    const halt = driver.deleteAllListings();
    await Promise.all([sync, halt]);
    expect(request.mock.calls.map(([config]) => (config as AxiosRequestConfig).method)).toEqual([
        'GET',
        'POST',
        'GET',
        'POST',
        'DELETE'
    ]);
});

test('does not remove listings when remote inventory listings cannot be read', async () => {
    request.mockResolvedValueOnce({ data: { success: false } });
    await expect(new NextCritDriver('key').syncSellListings([], '76561198000000000')).rejects.toThrow('did not return');
    expect(request).toHaveBeenCalledTimes(1);
});

test('leaves database integer widths to NextCrit', async () => {
    const driver = new NextCritDriver('key');
    await driver.createOrUpdateListing('9223372036854775808', new Currencies({ keys: 4294967296, metal: 4000 }));
    expect(request).toHaveBeenLastCalledWith(
        expect.objectContaining({
            data: [{ asset_id: '9223372036854775808', price: { keys: 4294967296, half_scrap: 72000 } }]
        })
    );
});
