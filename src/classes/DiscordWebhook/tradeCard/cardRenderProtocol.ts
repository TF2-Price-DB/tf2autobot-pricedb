import type { CurrentPure } from '../../../lib/tools/pure';
import type { StatsReadings } from './statsFacts';

export interface StockCardEntry {
    sku: string;
    name: string;
    amount: number;
    details?: string;
}

export function stockCardPageCount(entries: StockCardEntry[], pageSize = 20): number {
    return Math.ceil(entries.length / pageSize);
}

export type CardRenderRequest =
    | {
          type: 'price';
          sku: string;
          name: string;
          buy: string;
          sell: string;
          stock: number;
          limits: string;
          intent: string;
          autoprice: boolean;
          updated?: string;
          accountName: string;
          showQualityBorders: boolean;
      }
    | { type: 'pure'; stock: CurrentPure; accountName: string }
    | { type: 'rate'; buy: string; sell: string; source: string; accountName: string }
    | { type: 'sku-chart'; sku: string; keyRate: number }
    | {
          type: 'stock';
          entries: StockCardEntry[];
          accountName: string;
          title: string;
          pageIndex: number;
          pageSize: number;
          showQualityBorders: boolean;
      }
    | { type: 'trade'; payload: TradeCardPayload }
    | { type: 'stats'; readings: StatsReadings };

export interface CardRenderResult {
    ok: boolean;
    image?: string;
    error?: string;
}

/** The data the trade renderer needs, without a live Bot or TradeOffer object. */
export interface TradeCardPayload {
    offer: { id: string; dict: unknown; value?: unknown; highValue?: unknown; prices?: unknown };
    options: Record<string, unknown>;
    meta?: Record<string, unknown>;
    bot: Record<string, unknown>;
}
