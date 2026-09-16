import Currencies from '@tf2autobot/tf2-currencies';

export function tradeKeyPrice(
    prices: { buy: Currencies; sell: Currencies },
    containsItems: boolean,
    keysOnOurSide: boolean
): Currencies {
    return prices[containsItems || keysOnOurSide ? 'sell' : 'buy'];
}
