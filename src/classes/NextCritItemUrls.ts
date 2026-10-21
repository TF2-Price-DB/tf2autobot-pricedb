import axios from 'axios';
import { createHatVersionZ, unparseHatVersionZ } from '../vendor/the-future/createHat';
import log from '../lib/logger';

/** Cache the public HAT-to-item-ID feed used by crit.tf advanced search. */
export default class NextCritItemUrls {
    private readonly http = axios.create({ baseURL: 'https://crit.tf', timeout: 30000, maxRedirects: 0 });

    private ids = new Map<string, number>();

    private skuIds = new Map<string, number>();

    private nextRefresh = 0;

    private loading: Promise<boolean> | undefined;

    getUrl(hat: string): string {
        const key = NextCritItemUrls.key(hat);
        const id = this.ids.get(key);
        if (id !== undefined) return `https://crit.tf/item/${id}`;
        const skuKey = NextCritItemUrls.key(hat, true);
        // An explicitly requested attachment must never be silently broadened.
        if (skuKey !== key) return '';
        const skuId = this.skuIds.get(skuKey);
        // crit.tf's filter bits: marketability (2), killstreaker (8), sheen (16),
        // strange parts (64), strange filters (128), and spells (256).
        return skuId === undefined ? '' : `https://crit.tf/item/${skuId}/widened/474`;
    }

    refresh(): Promise<boolean> {
        if (this.loading !== undefined) return this.loading;
        if (Date.now() < this.nextRefresh) return Promise.resolve(false);
        this.loading = this.load()
            .then(({ ids, skuIds }) => {
                this.ids = ids;
                this.skuIds = skuIds;
                this.nextRefresh = Date.now() + 60 * 60 * 1000;
                return true;
            })
            .catch(() => {
                // Keep previously resolved URLs available during outages; retry in a minute.
                this.nextRefresh = Date.now() + 60000;
                log.warn('Failed to refresh crit.tf item links; keeping the cached mapping');
                return false;
            })
            .finally(() => {
                this.loading = undefined;
            });
        return this.loading;
    }

    private async load(): Promise<{ ids: Map<string, number>; skuIds: Map<string, number> }> {
        const ids = new Map<string, number>();
        const skuIds = new Map<string, number>();
        for (let start = 1; start <= 10000000; start += 10000) {
            const { data } = await this.http.get<unknown>(`/hyper-json/hats/${start}`, { responseType: 'text' });
            if (typeof data !== 'string') throw new Error('Invalid crit.tf item mapping');
            const rows = data.split('\x1e').filter(row => row !== '');
            if (rows.length === 0) return { ids, skuIds };
            let previous = start - 1;
            for (const row of rows) {
                const fields = row.split('\x1c');
                const id = Number(fields[0]);
                if (fields.length !== 3 || !Number.isSafeInteger(id) || id <= previous || id >= start + 10000) {
                    throw new Error('Invalid crit.tf item mapping row');
                }
                const key = NextCritItemUrls.key(fields[1]);
                if (!ids.has(key)) ids.set(key, id);
                const skuKey = NextCritItemUrls.key(fields[1], true);
                if (!skuIds.has(skuKey)) skuIds.set(skuKey, id);
                previous = id;
            }
        }
        throw new Error('crit.tf item mapping exceeded the supported size');
    }

    private static key(hat: string, skuAttributesOnly = false): string {
        if (!hat.startsWith('Z^')) throw new Error('Invalid NextCrit HAT');
        const props = unparseHatVersionZ(hat.slice(2));
        if (!props.marketHashName) throw new Error('Invalid NextCrit HAT');
        // Marketplace SKUs do not distinguish marketability or these attachments.
        props.marketable = false;
        if (skuAttributesOnly) {
            props.killstreakers = [];
            props.sheens = [];
            props.strangeParts = [];
            props.strangeFilters = [];
            props.spells = [];
        }
        props.marketHashName = props.marketHashName.replace(/%23/g, '#').replace(/^The /, '');
        return createHatVersionZ(props);
    }
}
