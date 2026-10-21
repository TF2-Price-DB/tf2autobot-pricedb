import { fromGluedString, fromGluedStringArray, toGluedStringArray, toGluedStringValue } from './gluedString';

export type HatVersionZProps = {
    marketHashName: string;
    tradable: boolean;
    marketable: boolean;
    craftable: boolean;
    festivized: boolean;
    loaner: boolean;
    qualities: string[];
    unusualEffects: string[];
    killstreakers: string[];
    sheens: string[];
    warPaints: string[];
    paints: string[];
    strangeParts: string[];
    strangeFilters: string[];
    spells: string[];
};

const WEAR_IN_PARENS = /\((?:Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle Scarred)\)/;

export function createHatVersionZ(props: HatVersionZProps): string {
    return (
        toGluedStringValue(props.marketHashName) +
        ';' +
        (props.tradable ? 'T' : '') +
        (props.marketable ? 'M' : '') +
        (props.craftable ? 'C' : '') +
        (props.festivized ? 'F' : '') +
        (props.loaner ? 'L' : '') +
        ';' +
        toGluedStringArray(props.qualities) +
        ';' +
        toGluedStringArray(props.unusualEffects) +
        ';' +
        toGluedStringArray(props.killstreakers) +
        ';' +
        toGluedStringArray(props.sheens) +
        ';' +
        toGluedStringArray(props.warPaints) +
        ';' +
        toGluedStringArray(props.paints) +
        ';' +
        toGluedStringArray(props.strangeParts) +
        ';' +
        toGluedStringArray(props.strangeFilters) +
        ';' +
        toGluedStringArray(props.spells)
    ).replace(/;+$/, '');
}

export function createHatVersionZProps(desc: Record<string, unknown>): HatVersionZProps {
    const tags = validateTags(desc.tags ?? []);
    const descriptions = validateSubDescriptions(desc.descriptions ?? []);

    const marketHashName = desc.market_hash_name;
    if (typeof marketHashName !== 'string') {
        throw Object.assign(new Error('Could not read market hash name'), { cause: desc.market_hash_name });
    }

    const tradable = !!desc.tradable;

    const marketable = !!desc.marketable;

    const craftable = !descriptions.some(({ value }) =>
        [
            '( Not Usable in Crafting )',
            '( Not Tradable, Marketable, or Usable in Crafting )',
            '( Not Tradable, Marketable, Usable in Crafting, or Gift Wrappable )'
        ].includes(value as string)
    );

    const festivized = pickDescriptions(descriptions, /^(?<parsed>Festivized)$/).length === 1;

    const loaner =
        pickDescriptions(descriptions, /^(?<parsed>\( Loaner - Cannot be traded, marketed, crafted, or modified \))$/)
            .length === 1;

    const qualities = pickTags(tags, 'Quality');

    const listsUnusualEffects =
        pickDescriptions(descriptions, /(?<parsed>Case Global Unusual Effect\(s\))/).length !== 0;
    const unusualEffects = listsUnusualEffects
        ? []
        : pickDescriptions(descriptions, /^★ Unusual Effect: (?<parsed>.+)$/);

    const killstreakers = pickDescriptions(descriptions, /^Killstreaker: (?<parsed>.+)$/);

    const sheens = pickDescriptions(descriptions, /^Sheen: (?<parsed>.+)$/);

    const warPaints = WEAR_IN_PARENS.test(marketHashName)
        ? pickDescriptions(descriptions, /^(?:✔|★) (?!Unusual Effect: )(?<parsed>.+)$/)
        : [];

    const paints = pickDescriptions(descriptions, /^Paint Color: (?<parsed>.+)$/);

    const spells = pickDescriptions(descriptions, /^Halloween: (?<parsed>.+) \(spell only active during event\)$/);

    const excludedStrangeParts = new Set([
        'Kill Assists',
        'Übers',
        'Sentry Kills',
        'Health Dispensed to Teammates',
        'Teammates Teleported',
        'Teammates Whipped',
        'Double Donks',
        'Humiliations'
    ]);
    const strangeParts: string[] = [];
    const strangeFilterSet = new Set<string>();
    for (const description of descriptions) {
        if (typeof description.value !== 'string') {
            throw Object.assign(new Error('Could not read sub description'), { cause: description });
        }
        const parsed = parseStrangeCounter(description.value);
        if (!parsed) continue;
        if (
            !excludedStrangeParts.has(parsed.part) &&
            !(parsed.part === 'Kills' && description.value.startsWith('     '))
        )
            strangeParts.push(parsed.part);
        if (parsed.filter !== undefined) strangeFilterSet.add(parsed.filter);
    }
    strangeParts.sort();
    const strangeFilters = [...strangeFilterSet].sort();

    return {
        marketHashName,
        tradable,
        marketable,
        craftable,
        festivized,
        loaner,
        qualities,
        unusualEffects,
        killstreakers,
        sheens,
        warPaints,
        paints,
        strangeParts,
        strangeFilters,
        spells
    };
}

export function unparseHatVersionZ(serialized: string): HatVersionZProps {
    if (serialized.endsWith(';')) {
        throw new Error('Invalid Hat Version Z: trailing semicolons are disallowed');
    }

    const fields = serialized.split(';');
    if (fields.length > 11) {
        throw new Error('Invalid Hat Version Z: too many fields');
    }

    return {
        marketHashName: fromGluedString(fields[0] ?? ''),
        tradable: (fields[1] ?? '').includes('T'),
        marketable: (fields[1] ?? '').includes('M'),
        craftable: (fields[1] ?? '').includes('C'),
        festivized: (fields[1] ?? '').includes('F'),
        loaner: (fields[1] ?? '').includes('L'),
        qualities: fromGluedStringArray(fields[2] ?? ''),
        unusualEffects: fromGluedStringArray(fields[3] ?? ''),
        killstreakers: fromGluedStringArray(fields[4] ?? ''),
        sheens: fromGluedStringArray(fields[5] ?? ''),
        warPaints: fromGluedStringArray(fields[6] ?? ''),
        paints: fromGluedStringArray(fields[7] ?? ''),
        strangeParts: fromGluedStringArray(fields[8] ?? ''),
        strangeFilters: fromGluedStringArray(fields[9] ?? ''),
        spells: fromGluedStringArray(fields[10] ?? '')
    };
}

function parseStrangeCounter(value: string): { part: string; filter?: string } | undefined {
    let counter: string;
    if (/^ {5}\S/.test(value)) {
        counter = value.slice(5);
    } else {
        const counterEnd = findClosingParen(value, 0);
        if (counterEnd !== value.length - 1) return undefined;
        counter = value.slice(1, counterEnd);
    }
    const counterMatch = /^(?<part>.+): \d+$/.exec(counter);
    if (!counterMatch) return undefined;

    const label = counterMatch.groups.part;
    const marker = label.indexOf(' (only ');
    if (marker === -1) return { part: label };

    const filterStart = marker + 1;
    const filterEnd = findClosingParen(label, filterStart);
    if (filterEnd !== label.length - 1) return undefined;

    const part = label.slice(0, marker);
    const filter = label.slice(filterStart + '(only '.length, filterEnd);
    if (!part || !filter) return undefined;

    return { part, filter };
}

function findClosingParen(value: string, start: number): number | undefined {
    if (value[start] !== '(') return undefined;
    let depth = 0;
    for (let index = start; index < value.length; index++) {
        if (value[index] === '(') depth++;
        if (value[index] === ')' && --depth === 0) return index;
    }
    return undefined;
}

function pickDescriptions(descriptions: Prop[], matcher: RegExp) {
    const out: string[] = [];

    for (const desc of descriptions) {
        if (typeof desc.value !== 'string') {
            throw Object.assign(new Error('Could not read sub description'), { cause: desc });
        }

        const match = matcher.exec(desc.value);
        if (match) {
            out.push(match.groups.parsed);
        }
    }

    return out.sort();
}

type Tag = {
    category: unknown;
    localized_tag_name: string;
};
type Prop = { value: unknown };

function pickTags(tags: Tag[], category: string) {
    const out: string[] = [];

    for (const tag of tags) {
        if (tag.category === category) {
            out.push(tag.localized_tag_name);
        }
    }

    return out.sort();
}

function validateTags(tags: unknown): Tag[] {
    const out: Tag[] = [];

    if (!Array.isArray(tags)) {
        throw Object.assign(new Error('Could not read tags'), { cause: tags });
    }

    for (const tag of tags as unknown[]) {
        if (typeof tag !== 'object' || tag === null || !('category' in tag) || !('localized_tag_name' in tag)) {
            throw Object.assign(new Error('Could not read tag'), { cause: tag });
        }
        const { localized_tag_name, category } = tag;
        if (typeof localized_tag_name !== 'string' || typeof category !== 'string') {
            throw Object.assign(new Error('Could not read tag fields'), { cause: tag });
        }

        out.push({ localized_tag_name, category });
    }

    return out;
}

function validateSubDescriptions(subDescriptions: unknown): Prop[] {
    const out: Prop[] = [];

    if (!Array.isArray(subDescriptions)) {
        throw Object.assign(new Error('Could not read descriptions'), { cause: subDescriptions });
    }

    for (const desc of subDescriptions as unknown[]) {
        if (typeof desc !== 'object' || desc === null || !('value' in desc)) {
            throw Object.assign(new Error('Could not read sub description'), { cause: desc });
        }

        if ('type' in desc && desc.type === 'usertext') continue;
        out.push(desc);
    }

    return out;
}
