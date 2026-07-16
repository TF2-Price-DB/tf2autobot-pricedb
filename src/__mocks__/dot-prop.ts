export function setProperty(target: Record<string, unknown>, path: string, value: unknown): void {
    const keys = path.split('.').filter(key => key.length > 0);
    let current = target;
    for (const key of keys.slice(0, -1)) {
        const next = current[key];
        if (typeof next !== 'object' || next === null || Array.isArray(next)) {
            current[key] = {};
        }
        current = current[key] as Record<string, unknown>;
    }
    if (keys.length > 0) current[keys[keys.length - 1]] = value;
}
