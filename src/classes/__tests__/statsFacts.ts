import { collectStatsReadings, outcomePanelCells, outcomeTotals } from '../DiscordWebhook/tradeCard/statsFacts';

const window = {
    processed: 12,
    accepted: { offer: { total: 5, countered: 1 }, sent: 3 },
    decline: { offer: { total: 2, countered: 0 }, sent: 0 },
    skipped: 1,
    canceled: { total: 1, byUser: 1, failedConfirmation: 0, unknown: 0 },
    invalid: 0
};

it('Accepted = recv + sent; Declined = recv + sent; Other = skipped + canceled + invalid', () => {
    expect(outcomeTotals(window)).toEqual({ accepted: 8, declined: 2, other: 2, processed: 12 });
});

it('accept % is accepted/processed, 0 when processed is 0', () => {
    expect(collectStatsReadings({ hours24: window, today: { ...window, processed: 0, accepted: { offer: { total: 0, countered: 0 }, sent: 0 }, decline: { offer: { total: 0, countered: 0 }, sent: 0 }, skipped: 0, canceled: { total: 0, byUser: 0, failedConfirmation: 0, unknown: 0 }, invalid: 0 } }).acceptPct24h).toBe(67); // 8/12
    expect(collectStatsReadings({ hours24: { ...window, processed: 0, accepted: { offer: { total: 0, countered: 0 }, sent: 0 } }, today: window }).acceptPct24h).toBe(0);
});

it('labels paired counts as 24h / today and accept % as last 24h', () => {
    const readings = collectStatsReadings({ hours24: window, today: window });
    expect(outcomePanelCells(readings)).toEqual([
        { label: 'ACCEPTED', value: '8 / 8', hint: '24h / today' },
        { label: 'DECLINED', value: '2 / 2', hint: '24h / today' },
        { label: 'OTHER', value: '2 / 2', hint: '24h / today' },
        { label: 'ACCEPT %', value: '67%', hint: 'last 24h' }
    ]);
});

