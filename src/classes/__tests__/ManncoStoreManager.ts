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
                content: { trade: { trade: { status: 3, items_received: '1', item_to_received: '[{"new_assetid":"2"}]' } } }
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
});
