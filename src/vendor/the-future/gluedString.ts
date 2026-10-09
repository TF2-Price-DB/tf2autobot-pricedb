export function toGluedStringValue(unknown: unknown) {
    if (Array.isArray(unknown)) {
        return toGluedStringArray(unknown);
    }

    if (typeof unknown === 'string') {
        return toGluedString(unknown);
    }

    if (typeof unknown === 'number') {
        return unknown.toString();
    }

    throw new Error('Unreachable' + JSON.stringify(unknown));
}

// NOTE: Sorts arr in-place!
export function toGluedStringArray(arr: unknown[]) {
    return arr
        .sort()
        .map(x => {
            if (typeof x !== 'string') {
                throw new Error('Unreachable' + JSON.stringify(x));
            }

            return toGluedString(x);
        })
        .join('*c');
}

export function fromGluedStringArray(string: string) {
    return string === '' ? [] : string.split('*c').map(fromGluedString);
}

export function toGluedString(string: string) {
    if (
        string.includes('*') ||
        string.includes('^') ||
        string.includes('  ') ||
        string.includes('\n ') ||
        string.includes(' \n')
    ) {
        throw Object.assign(new Error('Ambiguous encoding'), { cause: string });
    }

    return string.split('_').join('*u').split('\n').join('__').split(' ').join('_');
}

export function fromGluedString(string: string) {
    return string.split('__').join('\n').split('_').join(' ').split('*u').join('_');
}
