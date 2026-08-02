import * as i from '@tf2autobot/tradeoffer-manager';
import Bot from '../Bot';
import { JournalTfBoughtItem, JournalTfSoldItem } from '../JournalTfManager';
import { applyJournalTradeValuation } from '../MyHandler/offer/accepted/processAccepted';

const bot = {
    options: { autokeys: { enable: false } },
    pricelist: { getKeyPrice: { metal: 57.88 } }
} as Bot;

describe('Journal.tf trade valuation', () => {
    test('subtracts received pure from a key paid for one item', () => {
        const bought: JournalTfBoughtItem[] = [
            {
                sku: '562;6',
                itemName: 'Bone-Chilling Bonanza Case #142',
                buyPriceKeys: 0,
                buyPriceMetal: 2.11,
                quantity: 1,
                purchasedAt: '2026-07-14',
                notes: 'Added by bot from trade #1'
            }
        ];
        const sold: JournalTfSoldItem[] = [];

        applyJournalTradeValuation(
            bought,
            sold,
            {
                our: { '5021;6': 1 },
                their: { '562;6': 1, '5002;6': 55, '5001;6': 2, '5000;6': 1 }
            } as i.ItemsDict,
            bot,
            '1'
        );

        expect(bought[0].buyPriceKeys).toBe(0);
        expect(bought[0].buyPriceMetal).toBe(2.11);
    });

    test('marks item-for-item allocations as estimates', () => {
        const bought: JournalTfBoughtItem[] = [
            {
                sku: '200;6',
                itemName: 'Scattergun',
                buyPriceKeys: 0,
                buyPriceMetal: 2,
                quantity: 1,
                purchasedAt: '2026-07-14',
                notes: 'Added by bot from trade #2'
            }
        ];
        const sold: JournalTfSoldItem[] = [
            { sku: '201;6', sellPriceKeys: 0, sellPriceMetal: 3, quantity: 1, notes: 'Sold by bot from trade #2' }
        ];

        applyJournalTradeValuation(
            bought,
            sold,
            { our: { '201;6': 1 }, their: { '200;6': 1 } } as i.ItemsDict,
            bot,
            '2'
        );

        expect(bought[0].notes).toContain('[autobot:jtf:estimated]');
        expect(sold[0].notes).toContain('[autobot:jtf:estimated]');
    });
});
