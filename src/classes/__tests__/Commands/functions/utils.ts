import { normalizeUsdParameterAliases, parseItemAndAmountFromMessage } from '../../../Commands/functions/utils';

it('can parse one word item names', () => {
    let messageArgs = '5 Maul';
    let parsedMessage = parseItemAndAmountFromMessage(messageArgs);
    expect(parsedMessage).toEqual({ name: 'Maul', amount: 5 });

    messageArgs = 'Maul';
    parsedMessage = parseItemAndAmountFromMessage(messageArgs);
    expect(parsedMessage).toEqual({ name: 'Maul', amount: 1 });
});

it('can parse multiple word item names', () => {
    let messageArgs = '5 Nostromo Napalmer';
    let parsedMessage = parseItemAndAmountFromMessage(messageArgs);
    expect(parsedMessage).toEqual({ name: 'Nostromo Napalmer', amount: 5 });

    messageArgs = 'Nostromo Napalmer';
    parsedMessage = parseItemAndAmountFromMessage(messageArgs);
    expect(parsedMessage).toEqual({ name: 'Nostromo Napalmer', amount: 1 });
});

describe('normalizeUsdParameterAliases', () => {
    it.each([
        ['buyUsd', { buyUsd: 100 }, { buyUsd: 100 }],
        ['buyUSD', { buyUSD: 100 }, { buyUsd: 100 }],
        ['sellUsd', { sellUsd: 200 }, { sellUsd: 200 }],
        ['sellUSD', { sellUSD: 200 }, { sellUsd: 200 }],
        ['SellUsd', { SellUsd: 200 }, { sellUsd: 200 }]
    ])('normalizes %s', (_key, params, expected) => {
        expect(normalizeUsdParameterAliases(params)).toBeNull();
        expect(params).toEqual(expected);
    });

    it('removes aliases and accepts matching duplicate values', () => {
        const params = { buyUsd: 100, buyUSD: 100, sellUsd: 200, sellUSD: 200, SellUsd: 200 };

        expect(normalizeUsdParameterAliases(params)).toBeNull();
        expect(params).toEqual({ buyUsd: 100, sellUsd: 200 });
    });

    it('rejects conflicting values without changing the parameters', () => {
        const params = { buyUsd: 100, buyUSD: 200 };

        expect(normalizeUsdParameterAliases(params)).toBe(
            'Conflicting USD price parameters: buyUsd, buyUSD must have the same value.'
        );
        expect(params).toEqual({ buyUsd: 100, buyUSD: 200 });
    });
});
