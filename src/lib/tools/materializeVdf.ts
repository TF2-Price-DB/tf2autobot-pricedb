export interface MaterializedVdf<T> {
    value: T;
    stringCount: number;
}

type VdfRecord = Record<string, unknown>;

/**
 * Rebuilds VDF parser output with standalone strings. The VDF package returns
 * substring views, which keep its complete source document alive in V8.
 */
export function materializeVdf<T>(input: T): MaterializedVdf<T> {
    let stringCount = 0;

    const materializeString = (value: string): string => {
        stringCount++;

        // UTF-16LE preserves every JavaScript code unit, including unpaired
        // surrogates, while ensuring the result cannot retain a V8 substring
        // backing store from the original VDF response.
        return Buffer.from(value, 'utf16le').toString('utf16le');
    };

    const visit = (value: unknown): unknown => {
        if (typeof value === 'string') {
            return materializeString(value);
        }

        if (Array.isArray(value)) {
            return value.map(visit);
        }

        if (value !== null && typeof value === 'object') {
            const copy: VdfRecord = {};
            for (const [key, child] of Object.entries(value)) {
                copy[materializeString(key)] = visit(child);
            }
            return copy;
        }

        return value;
    };

    return { value: visit(input) as T, stringCount };
}
