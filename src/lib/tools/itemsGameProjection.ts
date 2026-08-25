import SchemaManager from '@tf2autobot/tf2-schema';

interface ItemsGameProjection {
    crateSeries: Map<string, number>;
    strangifierTargets: Map<string, string>;
    festivizable: Set<string>;
}

const projections = new WeakMap<SchemaManager.Schema, ItemsGameProjection>();

export function itemsGameProjectionEnabled(): boolean {
    return process.env.SCHEMA_ITEMS_GAME_COMPACT === 'true';
}

export function projectAndReleaseItemsGame(schema: SchemaManager.Schema): number {
    const items = schema.raw.items_game.items as Record<string, Record<string, unknown>>;
    const projection: ItemsGameProjection = {
        crateSeries: new Map(),
        strangifierTargets: new Map(),
        festivizable: new Set()
    };

    for (const [defindex, item] of Object.entries(items)) {
        const staticAttrs = item.static_attrs as Record<string, unknown> | undefined;
        const attributes = item.attributes as Record<string, unknown> | undefined;
        const crateSeries = toNumber(staticAttrs?.['set supply crate series']);
        const strangifierTarget =
            toString(attributes?.['tool target item']) ?? toString(staticAttrs?.['tool target item']);

        if (crateSeries !== undefined) projection.crateSeries.set(defindex, crateSeries);
        if (strangifierTarget !== undefined) projection.strangifierTargets.set(defindex, strangifierTarget);
        if ((item.tags as Record<string, unknown> | undefined)?.can_be_festivized == 1) {
            projection.festivizable.add(defindex);
        }
    }

    projections.set(schema, projection);
    schema.raw.items_game.items = {};
    return projection.crateSeries.size + projection.strangifierTargets.size + projection.festivizable.size;
}

export function getCrateSeries(schema: SchemaManager.Schema, defindex: number): number | undefined {
    const projected = projections.get(schema)?.crateSeries.get(String(defindex));
    if (projected !== undefined) return projected;

    const item = schema.raw.items_game.items[defindex] as Record<string, unknown> | undefined;
    return toNumber((item?.static_attrs as Record<string, unknown> | undefined)?.['set supply crate series']);
}

export function getStrangifierTarget(schema: SchemaManager.Schema, defindex: number): string | undefined {
    const projected = projections.get(schema)?.strangifierTargets.get(String(defindex));
    if (projected !== undefined) return projected;

    const item = schema.raw.items_game.items[defindex] as Record<string, unknown> | undefined;
    const staticAttrs = item?.static_attrs as Record<string, unknown> | undefined;
    const attributes = item?.attributes as Record<string, unknown> | undefined;
    return toString(attributes?.['tool target item']) ?? toString(staticAttrs?.['tool target item']);
}

export function canBeFestivized(schema: SchemaManager.Schema, defindex: number): boolean {
    const projection = projections.get(schema);
    if (projection) return projection.festivizable.has(String(defindex));

    const item = schema.raw.items_game.items[defindex] as Record<string, unknown> | undefined;
    return (item?.tags as Record<string, unknown> | undefined)?.can_be_festivized == 1;
}

export function getItemsGameProjectionEntryCount(schema: SchemaManager.Schema | undefined): number {
    const projection = schema ? projections.get(schema) : undefined;
    if (!projection) return 0;
    return projection.crateSeries.size + projection.strangifierTargets.size + projection.festivizable.size;
}

function toNumber(value: unknown): number | undefined {
    const rawValue = toString(value);
    if (rawValue === undefined) return undefined;
    const parsed = Number(rawValue);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function toString(value: unknown): string | undefined {
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (value !== null && typeof value === 'object' && 'value' in value) return toString(value.value);
    return undefined;
}
