import { materializeVdf } from './materializeVdf';

export interface Tf2ItemSchemaProjection {
    items: Record<string, { item_name: string }>;
}

export function tf2ItemSchemaProjectionEnabled(): boolean {
    return process.env.TF2_ITEM_SCHEMA_COMPACT === 'true';
}

export function projectTf2ItemSchema(itemSchema: unknown): Tf2ItemSchemaProjection {
    const items = (itemSchema as { items?: Record<string, { item_name?: unknown }> }).items ?? {};
    const projected: Tf2ItemSchemaProjection = { items: {} };

    for (const [defindex, item] of Object.entries(items)) {
        if (typeof item.item_name === 'string') {
            projected.items[defindex] = { item_name: item.item_name };
        }
    }

    return materializeVdf(projected).value;
}
