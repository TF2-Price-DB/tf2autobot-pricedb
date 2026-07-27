import axios from 'axios';
import ManncoStoreManager from '../ManncoStoreManager';

jest.mock('axios', () => ({
    __esModule: true,
    default: { create: jest.fn() }
}));

jest.mock('../../lib/files', () => ({
    readFile: jest.fn().mockResolvedValue(null),
    writeFile: jest.fn().mockResolvedValue(undefined)
}));

describe('ManncoStoreManager', () => {
    const api = { post: jest.fn(), request: jest.fn() };
    const priceDbApi = { get: jest.fn() };

    beforeEach(() => {
        jest.clearAllMocks();
        (axios.create as jest.Mock).mockReturnValueOnce(api).mockReturnValueOnce(priceDbApi);
        api.post.mockResolvedValue({ data: { success: true, err: false, content: { jwt: 'jwt' } } });
    });

    function createManager(): ManncoStoreManager {
        return new ManncoStoreManager('key', 'mannco-test.json');
    }

    test('unwraps Mannco nested deposit status and returns replacement asset IDs', async () => {
        api.request.mockResolvedValue({
            data: {
                success: true,
                err: false,
                content: {
                    trade: { trade: { status: 3, items_received: '1', item_to_received: '[{"new_assetid":"2"}]' } }
                }
            }
        });

        await expect(createManager().getDepositTradeStatus('42')).resolves.toEqual({
            trade: { status: 3, items_received: '2', item_to_received: '[{"new_assetid":"2"}]' }
        });
    });

    test('treats an outer-only deposit record as pending while Mannco creates the Steam trade', async () => {
        api.request.mockResolvedValue({
            data: { success: true, err: false, content: { trade: { id: 1033, state: 0, game: 440 } } }
        });

        await expect(createManager().getDepositTradeStatus('1033')).resolves.toEqual({
            trade: { id: 1033, state: 0, game: 440, status: 0 }
        });
    });

    test('uses content for Mannco business errors', async () => {
        api.request.mockResolvedValue({ data: { success: false, err: true, content: 'Not enough balance' } });

        await expect(createManager().getBalance()).rejects.toThrow('Mannco.store: Not enough balance');
    });

    test("resolves Mannco IDs from PriceDB's SKU path endpoint", async () => {
        priceDbApi.get.mockResolvedValue({ data: { sku: '725;6;uncraftable', manncoId: 1575 } });

        await expect(createManager().resolveManncoItemId('725;6;uncraftable')).resolves.toBe(1575);
        expect(priceDbApi.get).toHaveBeenCalledWith('/mannco/725%3B6%3Buncraftable');
    });

    test('refreshes the JWT once after an unauthorized response', async () => {
        api.request
            .mockRejectedValueOnce({ response: { status: 401, data: { content: 'forbidden' } } })
            .mockResolvedValueOnce({ data: { success: true, err: false, content: { balance: 123 } } });

        await expect(createManager().getBalance()).resolves.toBe(123);
        expect(api.post).toHaveBeenCalledTimes(2);
    });

    test('refreshes the JWT when Mannco reports an expired session in its response envelope', async () => {
        api.request
            .mockResolvedValueOnce({
                data: { success: false, err: true, content: 'You need to be connected to access this resource' }
            })
            .mockResolvedValueOnce({ data: { success: true, err: false, content: { balance: 456 } } });

        await expect(createManager().getBalance()).resolves.toBe(456);
        expect(api.post).toHaveBeenCalledTimes(2);
        expect(api.request).toHaveBeenCalledTimes(2);
    });

    test('retries a rate-limited request after Retry-After', async () => {
        jest.useFakeTimers();
        api.request
            .mockRejectedValueOnce({
                response: { status: 429, headers: { 'retry-after': '1' }, data: { content: 'wait' } }
            })
            .mockResolvedValueOnce({ data: { success: true, err: false, content: { balance: 321 } } });

        const balance = createManager().getBalance();
        await jest.advanceTimersByTimeAsync(1000);
        await expect(balance).resolves.toBe(321);
        jest.useRealTimers();
    });

    test('keeps matched operations until Steam acceptance is confirmed', async () => {
        const manager = createManager();
        const testManager = manager as unknown as { data: { operations: Record<string, unknown> } };
        testManager.data.operations = {
            'deposit:42': {
                id: 'deposit:42',
                type: 'deposit',
                status: 'pending',
                createdAt: 1,
                expectedSteamAssetIds: ['1'],
                manncoAssetIds: []
            }
        };

        expect(
            manager.matchesPendingDepositOffer({ id: '99', itemsToGive: [{ assetid: '1' }], itemsToReceive: [] })
        ).toBe(true);
        expect(manager.getOperations()[0].status).toBe('matched');
        await manager.markOfferAcceptanceFailed('99', new Error('Steam unavailable'));
        expect(manager.getOperations()[0]).toMatchObject({ status: 'matched', lastError: 'Steam unavailable' });
    });

    test('matches a deposit offer regardless of asset-ID order', () => {
        const manager = createManager();
        const testManager = manager as unknown as { data: { operations: Record<string, unknown> } };
        testManager.data.operations = {
            'deposit:42': {
                id: 'deposit:42',
                type: 'deposit',
                status: 'pending',
                createdAt: 1,
                expectedSteamAssetIds: ['10', '2'],
                manncoAssetIds: []
            }
        };

        expect(
            manager.matchesPendingDepositOffer({
                id: '99',
                itemsToGive: [{ assetid: '2' }, { assetid: '10' }],
                itemsToReceive: []
            })
        ).toBe(true);
    });

    test('creates unique cryptographic operation IDs', () => {
        const manager = createManager();
        const testManager = manager as unknown as {
            createOperation: (type: 'deposit' | 'withdrawal', assetIds: string[]) => { id: string };
        };

        const first = testManager.createOperation('withdrawal', ['1']);
        const second = testManager.createOperation('withdrawal', ['1']);

        expect(first.id).toMatch(/^withdrawal:creating:\d+:[0-9a-f-]{36}$/);
        expect(second.id).not.toBe(first.id);
    });

    test('reconciles a withdrawal when its Steam offer arrives before the periodic check', async () => {
        const manager = createManager();
        const testManager = manager as unknown as { data: { operations: Record<string, unknown> } };
        testManager.data.operations = {
            'withdrawal:creating:1:test': {
                id: 'withdrawal:creating:1:test',
                type: 'withdrawal',
                status: 'pending',
                createdAt: 1,
                expectedSteamAssetIds: ['17254509895'],
                manncoAssetIds: []
            }
        };
        api.request.mockResolvedValue({
            data: {
                success: true,
                err: false,
                content: {
                    trades: [
                        {
                            game: 440,
                            status: 0,
                            offerid: '9237043215',
                            items_received: '17254509895'
                        }
                    ]
                }
            }
        });

        await expect(
            manager.reconcileAndMatchPendingWithdrawalOffer({
                id: '9237043215',
                itemsToGive: [],
                itemsToReceive: [{ assetid: 'new-steam-asset-id' }]
            })
        ).resolves.toBe(true);
        expect(manager.getOperations()[0]).toMatchObject({ offerId: '9237043215', status: 'matched' });
    });

    test('completes a withdrawal from Mannco trade history when its Steam offer was accepted as a gift', async () => {
        const manager = createManager();
        const testManager = manager as unknown as { data: { operations: Record<string, unknown> } };
        testManager.data.operations = {
            'withdrawal:creating:1:test': {
                id: 'withdrawal:creating:1:test',
                type: 'withdrawal',
                status: 'pending',
                createdAt: 1,
                expectedSteamAssetIds: ['17266300609'],
                manncoAssetIds: []
            }
        };
        api.request
            .mockResolvedValueOnce({ data: { success: true, err: false, content: { trades: [] } } })
            .mockResolvedValueOnce({
                data: {
                    success: true,
                    err: false,
                    content: {
                        trades: [
                            {
                                game: 440,
                                status: 3,
                                offerid: '9240590198',
                                items_received: '17266300609'
                            }
                        ]
                    }
                }
            });

        await manager.reconcileOperations();
        expect(manager.getOperations()[0]).toMatchObject({
            offerId: '9240590198',
            status: 'completed'
        });
    });

    test('silently baselines history and reports each new sale only once', async () => {
        const manager = createManager();
        const response = (values: unknown[]) => ({
            data: { success: true, err: false, content: { values, count: values.length } }
        });
        const firstSale = { id: 'sale-1', item_id: 1575, name: 'Test Item', price: 90, count: 1 };

        api.request.mockResolvedValueOnce(response([firstSale])).mockResolvedValueOnce(response([]));
        await expect(manager.checkCompletedTransactions()).resolves.toEqual([]);

        const secondSale = { id: 'sale-2', item_id: 1575, name: 'Test Item', price: 95, count: 2 };
        api.request.mockResolvedValueOnce(response([secondSale, firstSale])).mockResolvedValueOnce(response([]));
        await expect(manager.checkCompletedTransactions()).resolves.toEqual([
            expect.objectContaining({ type: 'sale', id: 'sale:sale-2', quantity: 2, price: 95 })
        ]);

        api.request.mockResolvedValueOnce(response([secondSale, firstSale])).mockResolvedValueOnce(response([]));
        await expect(manager.checkCompletedTransactions()).resolves.toEqual([]);
    });

    test('reports purchase history only for tracked buy orders', async () => {
        const manager = createManager();
        const testManager = manager as unknown as {
            data: { buyOrders: Record<string, { itemId: number; amount: number; name: string }> };
        };
        testManager.data.buyOrders = { '725;6;uncraftable': { itemId: 1575, amount: 1, name: 'Tracked Item' } };
        const response = (values: unknown[]) => ({
            data: { success: true, err: false, content: { values, count: values.length } }
        });

        api.request.mockResolvedValueOnce(response([])).mockResolvedValueOnce(response([]));
        await manager.checkCompletedTransactions();
        api.request.mockResolvedValueOnce(response([])).mockResolvedValueOnce(
            response([
                { id: 'purchase-1', item_id: 1575, name: 'Tracked Item', price: 40, count: 1 },
                { id: 'purchase-2', item_id: 999, name: 'Untracked Item', price: 50, count: 1 }
            ])
        );

        await expect(manager.checkCompletedTransactions()).resolves.toEqual([
            expect.objectContaining({ type: 'buy', id: 'buy:purchase-1', sku: '725;6;uncraftable', price: 40 })
        ]);
    });
});
