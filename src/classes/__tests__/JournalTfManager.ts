import axios, { AxiosInstance } from 'axios';
import { promises as fs } from 'fs';
import path from 'path';
import JournalTfManager from '../JournalTfManager';

jest.mock('axios');
jest.mock('fs', () => ({
    promises: {
        readFile: jest.fn(),
        mkdir: jest.fn(),
        writeFile: jest.fn()
    }
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockedFs = fs as jest.Mocked<typeof fs>;
const getCreateMock = (): jest.MockedFunction<typeof axios.create> =>
    // eslint-disable-next-line @typescript-eslint/unbound-method
    mockedAxios.create as jest.MockedFunction<typeof axios.create>;

describe('JournalTfManager', () => {
    const stateFilePath = (): string =>
        path.join(
            __dirname,
            '..',
            '..',
            '..',
            'files',
            'journalTfManagerTest',
            `${expect.getState().currentTestName.replace(/[^a-z0-9]/gi, '-')}.json`
        );
    let getMock: jest.Mock;
    let postMock: jest.Mock;

    beforeEach(() => {
        getMock = jest.fn();
        postMock = jest.fn();
        getCreateMock().mockReturnValue({
            get: getMock,
            post: postMock
        } as unknown as AxiosInstance);
        const enoent = new Error('not found') as NodeJS.ErrnoException;
        enoent.code = 'ENOENT';
        mockedFs.readFile.mockRejectedValue(enoent);
        mockedFs.mkdir.mockResolvedValue(undefined);
        mockedFs.writeFile.mockResolvedValue(undefined);
    });

    test('creates axios client with journal.tf API key and static base URL', () => {
        new JournalTfManager('test-api-key', stateFilePath());

        expect(getCreateMock()).toHaveBeenCalledWith({
            baseURL: 'https://journal.tf/api/v1',
            headers: {
                'X-API-Key': 'test-api-key',
                'Content-Type': 'application/json'
            },
            timeout: 30000
        });
    });

    test('creates portfolio entries and sell records with expected payloads', async () => {
        const manager = new JournalTfManager('test-api-key', stateFilePath());
        const createPayload = {
            sku: '5021;6',
            item_name: 'Mann Co. Key',
            buy_price_keys: 0,
            buy_price_metal: 56.77,
            quantity: 10,
            purchased_at: '2026-06-07',
            notes: 'Added by bot from trade #1'
        };
        const sellPayload = {
            sell_price_keys: 1,
            sell_price_metal: 12.33,
            quantity_sold: 1,
            notes: 'Sold by bot from trade #1'
        };

        postMock
            .mockResolvedValueOnce({ data: { ok: true, data: { entry: { id: 'entry-1' } } } })
            .mockResolvedValueOnce({ data: { ok: true, data: { sell: { id: 'sell-1' } } } });

        await expect(manager.createPortfolioEntry(createPayload)).resolves.toEqual({
            ok: true,
            data: { entry: { id: 'entry-1' } }
        });
        await expect(manager.recordSell('entry-1', sellPayload)).resolves.toEqual({
            ok: true,
            data: { sell: { id: 'sell-1' } }
        });

        expect(postMock).toHaveBeenNthCalledWith(1, '/portfolio', createPayload);
        expect(postMock).toHaveBeenNthCalledWith(2, '/portfolio/entry-1/sells', sellPayload);
    });

    test('gets PnL with period query params', async () => {
        const manager = new JournalTfManager('test-api-key', stateFilePath());
        getMock.mockResolvedValue({ data: { ok: true, data: { period: 'all', sells: [], summary: {} } } });

        await expect(manager.getPnl('all')).resolves.toEqual({
            ok: true,
            data: { period: 'all', sells: [], summary: {} }
        });

        expect(getMock).toHaveBeenCalledWith('/pnl', { params: { period: 'all' } });
    });

    test('matches sells to active portfolio entries by FIFO', () => {
        const manager = new JournalTfManager('test-api-key', stateFilePath());
        const matches = manager.getMatchedSellEntries(
            [
                {
                    id: 'newer',
                    sku: '5021;6',
                    item_name: 'Mann Co. Key',
                    buy_price_keys: 0,
                    buy_price_metal: '56.77',
                    quantity: 5,
                    quantityRemaining: 5,
                    notes: null,
                    purchased_at: '2026-06-10T00:00:00.000Z',
                    status: 'active',
                    created_at: '2026-06-10T00:00:00.000Z'
                },
                {
                    id: 'sold-out',
                    sku: '5021;6',
                    item_name: 'Mann Co. Key',
                    buy_price_keys: 0,
                    buy_price_metal: '56.77',
                    quantity: 5,
                    quantityRemaining: 0,
                    notes: null,
                    purchased_at: '2026-06-01T00:00:00.000Z',
                    status: 'active',
                    created_at: '2026-06-01T00:00:00.000Z'
                },
                {
                    id: 'older',
                    sku: '5021;6',
                    item_name: 'Mann Co. Key',
                    buy_price_keys: 0,
                    buy_price_metal: '56.77',
                    quantity: 3,
                    quantityRemaining: 3,
                    notes: null,
                    purchased_at: '2026-06-05T00:00:00.000Z',
                    status: 'active',
                    created_at: '2026-06-05T00:00:00.000Z'
                }
            ],
            '5021;6',
            6
        );

        expect(matches.map(match => ({ id: match.entry.id, quantity: match.quantity }))).toEqual([
            { id: 'older', quantity: 3 },
            { id: 'newer', quantity: 3 }
        ]);
    });

    test('seedInventory only creates missing active quantities', async () => {
        const manager = new JournalTfManager('test-api-key', stateFilePath());
        getMock.mockResolvedValue({
            data: {
                ok: true,
                data: {
                    entries: [
                        {
                            id: 'existing-entry',
                            sku: '200;11',
                            item_name: 'Strange Scattergun',
                            buy_price_keys: 1,
                            buy_price_metal: '2.00',
                            quantity: 1,
                            quantityRemaining: 1,
                            notes: null,
                            purchased_at: '2026-06-01T00:00:00.000Z',
                            status: 'active',
                            created_at: '2026-06-01T00:00:00.000Z'
                        }
                    ]
                }
            }
        });
        postMock.mockResolvedValueOnce({ data: { ok: true, data: { entry: { id: 'seed-entry' } } } });

        await expect(
            manager.seedInventory('seed-1', [
                {
                    sku: '200;11',
                    itemName: 'Strange Scattergun',
                    buyPriceKeys: 1,
                    buyPriceMetal: 2,
                    quantity: 3,
                    purchasedAt: '2026-06-15',
                    notes: 'Seeded by bot from current inventory via !jtfseed'
                }
            ])
        ).resolves.toEqual({ created: 2, skipped: 1 });

        expect(postMock).toHaveBeenCalledWith(
            '/portfolio',
            expect.objectContaining({
                sku: '200;11',
                quantity: 2
            })
        );
    });

    test('syncTrade records buys, sells, and skips duplicate synced quantities', async () => {
        const manager = new JournalTfManager('test-api-key', stateFilePath());
        getMock.mockResolvedValue({
            data: {
                ok: true,
                data: {
                    entries: [
                        {
                            id: 'entry-1',
                            sku: '5021;6',
                            item_name: 'Mann Co. Key',
                            buy_price_keys: 0,
                            buy_price_metal: '56.77',
                            quantity: 10,
                            quantityRemaining: 10,
                            notes: null,
                            purchased_at: '2026-06-01T00:00:00.000Z',
                            status: 'active',
                            created_at: '2026-06-01T00:00:00.000Z'
                        }
                    ]
                }
            }
        });
        postMock
            .mockResolvedValueOnce({ data: { ok: true, data: { entry: { id: 'created-entry' } } } })
            .mockResolvedValueOnce({ data: { ok: true, data: { sell: { id: 'sell-1' } } } });

        await manager.syncTrade(
            'trade-1',
            [
                {
                    sku: '200;11',
                    itemName: 'Strange Scattergun',
                    buyPriceKeys: 1,
                    buyPriceMetal: 2,
                    quantity: 1,
                    purchasedAt: '2026-06-15',
                    notes: 'Added by bot from trade #trade-1'
                }
            ],
            [
                {
                    sku: '5021;6',
                    sellPriceKeys: 0,
                    sellPriceMetal: 56,
                    quantity: 1,
                    notes: 'Sold by bot from trade #trade-1'
                }
            ]
        );
        await manager.syncTrade(
            'trade-1',
            [
                {
                    sku: '200;11',
                    itemName: 'Strange Scattergun',
                    buyPriceKeys: 1,
                    buyPriceMetal: 2,
                    quantity: 1,
                    purchasedAt: '2026-06-15',
                    notes: 'Added by bot from trade #trade-1'
                }
            ],
            [
                {
                    sku: '5021;6',
                    sellPriceKeys: 0,
                    sellPriceMetal: 56,
                    quantity: 1,
                    notes: 'Sold by bot from trade #trade-1'
                }
            ]
        );

        expect(postMock).toHaveBeenCalledTimes(2);
        expect(postMock).toHaveBeenNthCalledWith(1, '/portfolio', expect.objectContaining({ sku: '200;11' }));
        expect(postMock).toHaveBeenNthCalledWith(
            2,
            '/portfolio/entry-1/sells',
            expect.objectContaining({ quantity_sold: 1 })
        );
    });
});
