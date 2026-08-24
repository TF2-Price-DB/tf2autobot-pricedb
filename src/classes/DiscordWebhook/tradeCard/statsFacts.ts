import type { DailyProfit } from '../../../lib/tools/profitRows';
import { convertedProfitString } from '../../../lib/tools/profit';


/**
 * Shared stats object for the ledger card and the !statsdw text.
 * Renderers must not re-sum windows or re-round accept %.
 */

export interface OutcomeTotals {
    accepted: number;
    declined: number;
    other: number;
    processed: number;
}

export interface StatsWindow {
    processed: number;
    accepted: {
        offer: { total: number; countered: number };
        sent: number;
    };
    decline: {
        offer: { total: number; countered: number };
        sent: number;
    };
    skipped: number;
    canceled: {
        total: number;
        byUser: number;
        failedConfirmation: number;
        unknown: number;
    };
    invalid: number;
}

export interface StatsReadings {
    totalDays: number;
    totalAccepted: number;
    keyBuy: number;
    keySell: number;
    raw24h: { keys: number; metal: number };
    rawAll: { keys: number; metal: number };
    converted24h: string;
    convertedAll: string;
    converted24hScrap: number;
    convertedAllScrap: number;
    hours24: OutcomeTotals;
    today: OutcomeTotals;
    acceptPct24h: number;
    hasEstimates: boolean;
    sinceDays: number;
    series: DailyProfit[];
}

export interface CollectStatsReadingsParams {
    hours24: StatsWindow;
    today: StatsWindow;
    totalDays?: number;
    totalAccepted?: number;
    keyBuy?: number;
    keySell?: number;
    raw24h?: { keys: number; metal: number };
    rawAll?: { keys: number; metal: number };
    hasEstimates?: boolean;
    sinceDays?: number;
    series?: DailyProfit[];
}

export function outcomeTotals(w: StatsWindow): OutcomeTotals {
    return {
        accepted: w.accepted.offer.total + w.accepted.sent,
        declined: w.decline.offer.total + w.decline.sent,
        other: w.skipped + w.canceled.total + w.invalid,
        processed: w.processed
    };
}

export interface OutcomePanelCell {
    label: string;
    value: string;
    hint: string;
}

export function outcomePanelCells(readings: StatsReadings): OutcomePanelCell[] {
    return [
        { label: 'ACCEPTED', value: `${readings.hours24.accepted} / ${readings.today.accepted}`, hint: '24h / today' },
        { label: 'DECLINED', value: `${readings.hours24.declined} / ${readings.today.declined}`, hint: '24h / today' },
        { label: 'OTHER', value: `${readings.hours24.other} / ${readings.today.other}`, hint: '24h / today' },
        { label: 'ACCEPT %', value: `${readings.acceptPct24h}%`, hint: 'last 24h' }
    ];
}

export function collectStatsReadings(params: CollectStatsReadingsParams): StatsReadings {
    const hours24 = outcomeTotals(params.hours24);
    const today = outcomeTotals(params.today);
    const keyBuy = params.keyBuy ?? 0;
    const keySell = params.keySell ?? 0;
    const raw24h = params.raw24h ?? { keys: 0, metal: 0 };
    const rawAll = params.rawAll ?? { keys: 0, metal: 0 };

    return {
        totalDays: params.totalDays ?? 0,
        totalAccepted: params.totalAccepted ?? 0,
        keyBuy,
        keySell,
        raw24h,
        rawAll,
        converted24h: convertedProfitString(raw24h.keys, raw24h.metal, keySell),
        convertedAll: convertedProfitString(rawAll.keys, rawAll.metal, keySell),
        converted24hScrap: Math.round(raw24h.keys * keySell * 9 + raw24h.metal * 9),
        convertedAllScrap: Math.round(rawAll.keys * keySell * 9 + rawAll.metal * 9),
        hours24,
        today,
        acceptPct24h: hours24.processed === 0 ? 0 : Math.round((hours24.accepted / hours24.processed) * 100),
        hasEstimates: params.hasEstimates ?? false,
        sinceDays: params.sinceDays ?? 0,
        series: params.series ?? []
    };
}
