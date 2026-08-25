import fs from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';

const MAX_SNAPSHOTS = 48;
const MAX_LABEL_LENGTH = 80;

export interface SchemaMemoryShape {
    pricedbItems: number;
    pricedbItemsGameEntries: number;
    pricedbItemsGameProjectionEntries: number;
    tf2ItemSchemaEntries: number;
    localizationEntries: number;
}

export interface MemorySnapshot {
    label: string;
    capturedAt: string;
    uptimeSeconds: number;
    memory: NodeJS.MemoryUsage;
    heap: v8.HeapInfo;
    spaces: v8.HeapSpaceInfo[];
    schema: SchemaMemoryShape;
}

const snapshots: MemorySnapshot[] = [];

export function memoryDiagnosticsEnabled(): boolean {
    return process.env.MEMORY_DIAGNOSTICS_ENABLED === 'true';
}

export function captureMemorySnapshot(label: string, schema: SchemaMemoryShape): MemorySnapshot {
    const snapshot: MemorySnapshot = {
        label: sanitizeLabel(label),
        capturedAt: new Date().toISOString(),
        uptimeSeconds: Math.floor(process.uptime()),
        memory: process.memoryUsage(),
        heap: v8.getHeapStatistics(),
        spaces: v8.getHeapSpaceStatistics(),
        schema
    };

    snapshots.push(snapshot);
    if (snapshots.length > MAX_SNAPSHOTS) snapshots.splice(0, snapshots.length - MAX_SNAPSHOTS);
    return snapshot;
}

export function getMemorySnapshots(): readonly MemorySnapshot[] {
    return snapshots;
}

/** Requires Node to be started with --expose-gc. */
export function collectGarbage(): boolean {
    const runtime = global as typeof global & { gc?: () => void };
    if (typeof runtime.gc !== 'function') return false;
    runtime.gc();
    runtime.gc();
    return true;
}

export function writeHeapSnapshot(directory: string, label: string): string {
    fs.mkdirSync(directory, { recursive: true });
    const filename = `heap-${new Date().toISOString().replace(/[:.]/g, '-')}-${sanitizeLabel(label)}.heapsnapshot`;
    return v8.writeHeapSnapshot(path.join(directory, filename));
}

function sanitizeLabel(label: string): string {
    return label.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, MAX_LABEL_LENGTH) || 'snapshot';
}
