import path from 'node:path';
import { TradeOffer, ItemsDict, ItemsValue, OurTheirItemsDict, HighValueOutput } from '@tf2autobot/tradeoffer-manager';
import Currencies from '@tf2autobot/tf2-currencies';
import SKU from '@tf2autobot/tf2-sku';
import { createCanvas, GlobalFonts, Image, SKRSContext2D } from '@napi-rs/canvas';
import Bot from '../../Bot';
import log from '../../../lib/logger';
import { testPriceKey } from '../../../lib/tools/export';
import { qualityColorHex } from '../../../lib/tools/qualityColor';
import {
    amountOf,
    collectPricedItems,
    collectStatReadings,
    PricedItem,
    priceRows,
    PURE_SKUS,
    StatReading,
    unitValueOf
} from './offerFacts';
import { getItemIcon, loadAvatar, TILE_SIZE } from './itemImageCache';
import {
    AttributeIcon,
    buildTileAttributes,
    collectScanned,
    ScannedMap,
    stripPaint,
    TileAttributes
} from './itemAttributes';

// ── Layout ────────────────────────────────────────────────────────────────────
// The two sides sit side by side, in a grid fixed at four by two and never sized
// to the trade. Discord stretches the card to the container's width whatever its
// source size, so a narrower canvas is the same card at a larger scale — sizing
// to the item count made small trades render magnified and larger ones render
// small, which read as the summary changing size at random.
//
// Eight slots a side: eight items when they fit, or seven plus the overflow chip
// when they do not (see selectTiles). The item list below the card names every
// item anyway, including the ones the chip stands in for.
const TILE_COLUMNS = 4;
const TILE_ROWS = 2;
/** Tiles one side can show, the last of which may be the overflow chip. */
const TILE_SLOTS = TILE_COLUMNS * TILE_ROWS;

/**
 * Four columns make the card 1.32x wider in source pixels than three did, so at
 * a fixed container width everything on it renders ~24% smaller. Every font,
 * pill and icon is scaled by that ratio to hold its on-screen size; the bases
 * below stay the values tuned for the three-column card rather than becoming
 * pre-multiplied magic numbers.
 *
 * The tile art is exempt on purpose — it is the subject of the card, and showing
 * eight items a side instead of three has to cost something.
 */
const CHROME_SCALE = 1.32;
const px = (base: number): number => Math.round(base * CHROME_SCALE);
/** Space between the two side columns, holding their divider. */
const COLUMN_GAP = 40;
const PAD = 24;
const TILE = TILE_SIZE;
const TILE_GAP = 16;
const TILE_RADIUS = 16;
const ICON_INSET = 18;
const HEADER_HEIGHT = px(34);
const HEADER_GAP = 8;
const BAND_GAP = 20;
const DIVIDER_HEIGHT = 1;
// One baseline grid every stat cell draws to, whether or not it uses each line,
// so a cell carrying a note no longer pushes its value out of step with its
// neighbours. These are the sizes for a cell BASE_STAT_INNER wide; statLayout
// scales them together so the text fills its box at any card width.
const BASE_STAT_INNER = 216;
/**
 * Not scaled by CHROME_SCALE, unlike the rest of the chrome: the panel is bot
 * status, and holding it at its old on-screen size while the tiles shrank 24%
 * made it the largest thing on the card.
 */
const MAX_STAT_SCALE = 1.3;
/** Narrower than the card and centred under it, so it reads as a footnote rather than a section. */
const STAT_PANEL_WIDTH_RATIO = 0.62;
const BASE_STAT_LABEL_BASELINE = 30;
const BASE_STAT_VALUE_BASELINE = 70;
const BASE_STAT_SUB_BASELINE = 96;
const BASE_STAT_NOTE_BASELINE = 122;
const BASE_STAT_HEIGHT = BASE_STAT_NOTE_BASELINE + 16;
const BASE_STAT_LABEL_SIZE = 18;
const BASE_STAT_VALUE_SIZE = 30;
const BASE_STAT_SUB_SIZE = 20;
const BASE_STAT_NOTE_SIZE = 17;
const STAT_RADIUS = 14;
const STAT_PAD = 14;
const PRICE_HEADER_HEIGHT = px(36);
const PRICE_ROW_HEIGHT = px(46);
// The partner's own strip at the very top: a circular avatar and the persona
// name, above the bands. ~65 source pixels hold it, so the card's aspect ratio
// stays inside the 1.5–4.0 rails at both extremes of the grid.
const AVATAR_SIZE = px(34);
const PROFILE_HEIGHT = px(49);
const PROFILE_GAP = px(16);
// A marker on the art, not a second subject: inside ~30% of the tile.
const ICON_SIZE = px(30);
const ICON_GAP = px(5);
const ICON_PAD = px(9);
const SWATCH_RADIUS = px(12);

/**
 * Height of the whole tile section, for however many rows the trade needs.
 *
 * Rows are content-sized even though the width is not: width drives the scale
 * Discord renders at and must never vary, height does not, and a row reserved
 * for tiles that are not there is a blank half-card under every small trade.
 */
const bandHeight = (rows: number): number => HEADER_HEIGHT + HEADER_GAP + rows * TILE + (rows - 1) * TILE_GAP;

/** How many rows the busier side needs, capped at the grid. */
function rowsNeeded(...sides: TileSpec[][]): number {
    const most = Math.max(1, ...sides.map(tiles => tiles.length));

    return Math.min(TILE_ROWS, Math.ceil(most / TILE_COLUMNS));
}

/** Width of one side's column. Constant, so every card renders at one scale. */
const COLUMN_WIDTH = TILE_COLUMNS * TILE + (TILE_COLUMNS - 1) * TILE_GAP;
const CARD_WIDTH = PAD * 2 + COLUMN_WIDTH * 2 + COLUMN_GAP;

interface StatLayout {
    height: number;
    labelBaseline: number;
    valueBaseline: number;
    subBaseline: number;
    noteBaseline: number;
    labelSize: number;
    valueSize: number;
    subSize: number;
    noteSize: number;
}

/** Where the stat panel sits: an inset band, centred under the card. */
function statPanelBox(cardWidth: number): { x: number; width: number } {
    const width = Math.round(cardWidth * STAT_PANEL_WIDTH_RATIO);
    return { x: Math.round((cardWidth - width) / 2), width };
}

/**
 * Type and spacing for the stat panel, scaled to how much room each cell has.
 * One factor for every size means text that fitted at the base width still fits
 * at any larger one, so the panel fills its box with no per-string measuring.
 */
function statLayout(panelWidth: number, cells: number): StatLayout {
    const inner = panelWidth / Math.max(1, cells) - STAT_PAD * 2;
    const scale = Math.min(MAX_STAT_SCALE, Math.max(1, inner / BASE_STAT_INNER));
    const at = (base: number): number => Math.round(base * scale);

    return {
        height: at(BASE_STAT_HEIGHT),
        labelBaseline: at(BASE_STAT_LABEL_BASELINE),
        valueBaseline: at(BASE_STAT_VALUE_BASELINE),
        subBaseline: at(BASE_STAT_SUB_BASELINE),
        noteBaseline: at(BASE_STAT_NOTE_BASELINE),
        labelSize: at(BASE_STAT_LABEL_SIZE),
        valueSize: at(BASE_STAT_VALUE_SIZE),
        subSize: at(BASE_STAT_SUB_SIZE),
        noteSize: at(BASE_STAT_NOTE_SIZE)
    };
}

// ── Palette ───────────────────────────────────────────────────────────────────
// The card owns its background rather than letting Discord's show through.
// Discord composites it onto #2B2D31 (dark) or #F2F3F5 (light) and never says
// which, so one PNG has to serve both, and no single mid grey clears ~2.9:1 in
// each direction where body text wants 4.5:1. The alternative — staying
// transparent and outlining every glyph — was built and compared side by side;
// it wins on dark theme and reads as debris on light, where the card has no edge
// of its own. So: a mid-dark surface with a hairline border. Every colour below
// is tuned against CARD_BG alone and holds whichever theme is looking at it.
const CARD_BG = '#2F3136';
const CARD_BORDER = 'rgba(255, 255, 255, 0.09)';
const CARD_RADIUS = 24;

const TILE_FILL = 'rgba(255, 255, 255, 0.06)';
const TILE_BORDER_FALLBACK = 'rgba(255, 255, 255, 0.18)';
const CHIP_BORDER = 'rgba(255, 255, 255, 0.24)';
const DIVIDER_COLOR = 'rgba(255, 255, 255, 0.12)';
const STAT_FILL = 'rgba(255, 255, 255, 0.05)';
const STAT_BORDER = 'rgba(255, 255, 255, 0.13)';
// Near-white, which only a card that owns its background can afford.
const LABEL_COLOR = '#D2D6DB';
const VALUE_COLOR = '#F6F7F8';
const MUTED_COLOR = 'rgba(206, 211, 217, 0.95)';
const PILL_FILL = 'rgba(0, 0, 0, 0.72)';
const PILL_TEXT = '#FFFFFF';
// Glyphs sit straight on the art, so each needs an edge — a halo, not a chip.
const ICON_HALO = 'rgba(0, 0, 0, 0.75)';
const ICON_HALO_BLUR = px(6);
const SWATCH_RING = 'rgba(0, 0, 0, 0.55)';

// Discord's own accents, which only a card with a backing of its own can use.
const PROFIT_COLOR = '#57F287';
const PROFIT_FILL = 'rgba(20, 60, 35, 0.55)';
const LOSS_COLOR = '#FF6B6E';
const LOSS_FILL = 'rgba(70, 22, 24, 0.55)';

const FONT_REGULAR = 'TradeCardSans';
const FONT_SEMIBOLD = 'TradeCardSansSemi';
const FONT_EMOJI = 'TradeCardEmoji';

interface TileSpec {
    kind: 'item' | 'overflow' | 'empty';
    /** Present for `item` tiles; this is what gets resolved to an icon. */
    sku?: string;
    amount?: number;
    /** SKU quality index, used for the border colour. */
    quality?: string;
    /** Present for `overflow` tiles: how many items did not fit. */
    hidden?: number;
    /** Spell / part / killstreak icons and the paint swatch. */
    attributes?: TileAttributes;
}

interface StatBox {
    label: string;
    /** Headline figure. Mutually exclusive with `rows`. */
    value?: string;
    sub?: string;
    note?: string;
    /** `[caption, figure]` pairs, for a box that carries more than one number. */
    rows?: [string, string][];
}

let fontsRegistered = false;
let emojiAvailable = false;

/** Register the shared typefaces used by all rendered Discord cards. */
export function registerTradeCardFonts(): void {
    if (fontsRegistered) {
        return;
    }

    // src/classes/DiscordWebhook/tradeCard → repo root is four levels up, and
    // dist/ mirrors src/ depth exactly, so this resolves the same either way.
    const dir = path.resolve(__dirname, '../../../../assets/fonts');
    GlobalFonts.registerFromPath(path.join(dir, 'Inter-Regular.ttf'), FONT_REGULAR);
    GlobalFonts.registerFromPath(path.join(dir, 'Inter-SemiBold.ttf'), FONT_SEMIBOLD);

    // Monochrome on purpose: a colour emoji font paints its own palette and
    // cannot be tinted, which would cost the killstreak icon its sheen colour.
    // Losing it costs only the icons, so it must not take the card down.
    try {
        // registerFromPath returns a FontKey, or null when the file would not load.
        emojiAvailable = GlobalFonts.registerFromPath(path.join(dir, 'NotoEmoji-Subset.ttf'), FONT_EMOJI) !== null;
    } catch (err) {
        log.debug('Could not register the trade card emoji font; attribute icons are off: ', err);
        emojiAvailable = false;
    }

    fontsRegistered = true;
}

function qualityOf(sku: string): string | undefined {
    if (!testPriceKey(sku)) {
        return undefined;
    }

    try {
        return String(SKU.fromString(sku).quality);
    } catch (err) {
        return undefined;
    }
}

/**
 * Turn one side of a trade into at most `maxSlots` tiles.
 *
 * Real items come first, ordered by unit value so the headline item of a trade
 * always earns a slot. Each pure currency collapses into a single `xN` tile —
 * the precise amount is already spelled out in the band header, so spending
 * four slots on metal would crowd out the items worth looking at.
 *
 * Kept free of Bot/offer so it can be tested directly: `valueOf` is whatever
 * the caller knows about per-unit worth, in scrap.
 */
export function selectTiles(
    dict: OurTheirItemsDict,
    valueOf: (sku: string) => number,
    maxSlots: number,
    scanned: ScannedMap = {}
): TileSpec[] {
    if (!dict || Object.keys(dict).length === 0) {
        return [{ kind: 'empty' }];
    }

    const items: TileSpec[] = [];
    const pure: TileSpec[] = [];

    for (const priceKey of Object.keys(dict)) {
        const amount = amountOf(dict[priceKey]);

        if (amount <= 0) {
            continue;
        }

        const sku = stripPaint(priceKey);
        const tile: TileSpec = {
            kind: 'item',
            sku,
            amount,
            quality: qualityOf(sku),
            attributes: buildTileAttributes(sku, scanned[sku])
        };

        if (PURE_SKUS.includes(sku)) {
            pure.push(tile);
        } else {
            items.push(tile);
        }
    }

    if (items.length === 0 && pure.length === 0) {
        return [{ kind: 'empty' }];
    }

    items.sort((a, b) => valueOf(b.sku) - valueOf(a.sku));
    pure.sort((a, b) => PURE_SKUS.indexOf(a.sku) - PURE_SKUS.indexOf(b.sku));

    const ordered = items.concat(pure);

    if (ordered.length <= maxSlots) {
        return ordered;
    }

    const shown = ordered.slice(0, maxSlots - 1);

    // Distinct skus, not the sum of their quantities: one tile is one sku, and
    // the item list and price rows below the card count entries the same way.
    return shown.concat([{ kind: 'overflow', hidden: ordered.length - shown.length }]);
}

function roundedRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
}

function drawCountPill(ctx: SKRSContext2D, x: number, y: number, amount: number): void {
    const label = `x${amount}`;
    ctx.font = `${px(28)}px ${FONT_SEMIBOLD}`;

    const textWidth = ctx.measureText(label).width;
    const pillWidth = textWidth + px(24);
    const pillHeight = px(42);
    const pillX = x + TILE - pillWidth - px(10);
    const pillY = y + TILE - pillHeight - px(10);

    ctx.fillStyle = PILL_FILL;
    roundedRect(ctx, pillX, pillY, pillWidth, pillHeight, pillHeight / 2);
    ctx.fill();

    ctx.fillStyle = PILL_TEXT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, pillX + pillWidth / 2, pillY + pillHeight / 2 + 1);
}

/** Fixed cell centres for the 2x2 grid, relative to the tile's top-left. */
const ICON_SLOT_OFFSETS: Record<AttributeIcon['slot'], [number, number]> = {
    killstreak: [0, 0],
    parts: [1, 0],
    spell1: [0, 1],
    spell2: [1, 1]
};

/**
 * The attribute grid, in the tile's top-left quadrant so it never collides with
 * the count pill opposite. An empty slot stays empty rather than letting its
 * neighbours slide over: a moved icon would read as a different attribute.
 */
function drawAttributeIcons(ctx: SKRSContext2D, icons: AttributeIcon[], x: number, y: number): void {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${ICON_SIZE}px ${FONT_EMOJI}`;
    ctx.shadowColor = ICON_HALO;
    ctx.shadowBlur = ICON_HALO_BLUR;

    for (const icon of icons) {
        const [col, row] = ICON_SLOT_OFFSETS[icon.slot];

        ctx.fillStyle = icon.color;
        ctx.fillText(
            icon.glyph,
            x + ICON_PAD + ICON_SIZE / 2 + col * (ICON_SIZE + ICON_GAP),
            y + ICON_PAD + ICON_SIZE / 2 + row * (ICON_SIZE + ICON_GAP)
        );
    }

    ctx.restore();
}

/** Paint, as a disc of its own colour, clear of the icon grid and the count pill. */
function drawPaintSwatch(ctx: SKRSContext2D, color: string, x: number, y: number): void {
    const cx = x + ICON_PAD + SWATCH_RADIUS;
    const cy = y + TILE - ICON_PAD - SWATCH_RADIUS;

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cx, cy, SWATCH_RADIUS, 0, Math.PI * 2);
    ctx.fill();

    // A ring, so a near-white paint still has an edge on light theme and a
    // near-black one still has an edge on dark.
    ctx.strokeStyle = SWATCH_RING;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, SWATCH_RADIUS - 1, 0, Math.PI * 2);
    ctx.stroke();
}

function drawTile(
    ctx: SKRSContext2D,
    tile: TileSpec,
    icon: Image | null,
    x: number,
    y: number,
    borders: boolean
): void {
    if (tile.kind === 'item') {
        ctx.fillStyle = TILE_FILL;
        roundedRect(ctx, x, y, TILE, TILE, TILE_RADIUS);
        ctx.fill();

        if (borders) {
            ctx.strokeStyle = (tile.quality && qualityColorHex[tile.quality]) || TILE_BORDER_FALLBACK;
            ctx.lineWidth = 3;
            roundedRect(ctx, x + 1.5, y + 1.5, TILE - 3, TILE - 3, TILE_RADIUS - 1.5);
            ctx.stroke();
        }

        if (icon) {
            const size = TILE - ICON_INSET * 2;
            ctx.drawImage(icon, x + ICON_INSET, y + ICON_INSET, size, size);
        } else {
            // Art we could not resolve. Hold the slot so the row stays aligned.
            ctx.fillStyle = MUTED_COLOR;
            ctx.font = `${px(72)}px ${FONT_SEMIBOLD}`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('?', x + TILE / 2, y + TILE / 2);
        }

        if (tile.amount > 1) {
            drawCountPill(ctx, x, y, tile.amount);
        }

        if (tile.attributes?.paint) {
            drawPaintSwatch(ctx, tile.attributes.paint, x, y);
        }

        // Without the emoji font every glyph would draw as nothing anyway; skip
        // the work rather than relying on that.
        if (emojiAvailable && tile.attributes?.icons.length) {
            drawAttributeIcons(ctx, tile.attributes.icons, x, y);
        }

        return;
    }

    // overflow / empty: same footprint, dashed outline, no fill weight
    ctx.strokeStyle = CHIP_BORDER;
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    roundedRect(ctx, x + 1, y + 1, TILE - 2, TILE - 2, TILE_RADIUS);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = MUTED_COLOR;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (tile.kind === 'overflow') {
        ctx.font = `${px(38)}px ${FONT_SEMIBOLD}`;
        ctx.fillText(`+${tile.hidden}`, x + TILE / 2, y + TILE / 2 - px(16));
        ctx.font = `${px(24)}px ${FONT_REGULAR}`;
        ctx.fillText('more', x + TILE / 2, y + TILE / 2 + px(22));
    } else {
        ctx.font = `${px(26)}px ${FONT_REGULAR}`;
        ctx.fillText('nothing', x + TILE / 2, y + TILE / 2);
    }
}

/** The surplus a trade earned, as a tinted chip. Returns its width, so the total can clear it. */
function drawDeltaChip(ctx: SKRSContext2D, right: number, baseline: number, text: string, positive: boolean): number {
    ctx.font = `${px(22)}px ${FONT_SEMIBOLD}`;
    const textWidth = ctx.measureText(text).width;
    const chipWidth = textWidth + px(22);
    const chipHeight = px(32);
    const chipX = right - chipWidth;
    const chipY = baseline - chipHeight + px(8);

    ctx.fillStyle = positive ? PROFIT_FILL : LOSS_FILL;
    roundedRect(ctx, chipX, chipY, chipWidth, chipHeight, chipHeight / 2);
    ctx.fill();

    ctx.strokeStyle = positive ? PROFIT_COLOR : LOSS_COLOR;
    ctx.lineWidth = 1.5;
    roundedRect(ctx, chipX + 0.75, chipY + 0.75, chipWidth - 1.5, chipHeight - 1.5, chipHeight / 2);
    ctx.stroke();

    ctx.fillStyle = positive ? PROFIT_COLOR : LOSS_COLOR;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, chipX + chipWidth / 2, chipY + chipHeight / 2 + 1);
    ctx.textBaseline = 'alphabetic';

    return chipWidth;
}

/** One side of the trade, drawn inside its own column of the tile row. */
function drawBand(
    ctx: SKRSContext2D,
    x: number,
    width: number,
    label: string,
    value: string,
    tiles: TileSpec[],
    icons: (Image | null)[],
    y: number,
    borders: boolean,
    delta?: { text: string; positive: boolean }
): void {
    ctx.textBaseline = 'alphabetic';

    // The label is structure and should recede; the currency is the content of
    // the band, so it carries the heavier weight despite the matching colour.
    ctx.font = `${px(22)}px ${FONT_REGULAR}`;
    ctx.fillStyle = LABEL_COLOR;
    ctx.textAlign = 'left';
    ctx.fillText(label.toUpperCase(), x, y + px(23));

    let right = x + width;

    if (delta) {
        right -= drawDeltaChip(ctx, right, y + px(23), delta.text, delta.positive) + px(10);
    }

    if (value) {
        ctx.font = `${px(22)}px ${FONT_SEMIBOLD}`;
        ctx.fillStyle = VALUE_COLOR;
        ctx.textAlign = 'right';
        // Only what the label leaves: the two share one baseline in a half-width column.
        ctx.fillText(fitText(ctx, value, FONT_SEMIBOLD, px(22), right - x - px(90)), right, y + px(23));
    }

    // Left to right, then wrap: the first row holds the most valuable items,
    // since selectTiles has already ordered them by unit value.
    const tileY = y + HEADER_HEIGHT + HEADER_GAP;
    tiles.forEach((tile, i) => {
        const col = i % TILE_COLUMNS;
        const row = Math.floor(i / TILE_COLUMNS);

        drawTile(ctx, tile, icons[i], x + col * (TILE + TILE_GAP), tileY + row * (TILE + TILE_GAP), borders);
    });
}

/**
 * Shrink the font until the text fits. Below 12px it stops being readable at
 * Discord's render scale, so anything still too wide is clipped instead —
 * the returned string is what the caller must draw.
 */
function fitText(ctx: SKRSContext2D, text: string, font: string, size: number, maxWidth: number): string {
    let current = size;
    ctx.font = `${current}px ${font}`;

    while (current > px(12) && ctx.measureText(text).width > maxWidth) {
        current -= 1;
        ctx.font = `${current}px ${font}`;
    }

    if (ctx.measureText(text).width <= maxWidth) {
        return text;
    }

    let clipped = text;
    while (clipped.length > 1 && ctx.measureText(`${clipped}…`).width > maxWidth) {
        clipped = clipped.slice(0, -1);
    }

    return `${clipped.trimEnd()}…`;
}

/** One panel split by hairlines, not four outlined boxes: four outlines read as four subjects. */
function drawStatPanel(ctx: SKRSContext2D, cardWidth: number, boxes: StatBox[], y: number, layout: StatLayout): void {
    const { x, width } = statPanelBox(cardWidth);

    ctx.fillStyle = STAT_FILL;
    roundedRect(ctx, x, y, width, layout.height, STAT_RADIUS);
    ctx.fill();

    ctx.strokeStyle = STAT_BORDER;
    ctx.lineWidth = 1.5;
    roundedRect(ctx, x + 0.75, y + 0.75, width - 1.5, layout.height - 1.5, STAT_RADIUS);
    ctx.stroke();

    const cell = width / boxes.length;

    ctx.fillStyle = DIVIDER_COLOR;
    for (let i = 1; i < boxes.length; i++) {
        // Inset so the hairline stops short of the panel's own rounded border.
        ctx.fillRect(x + i * cell, y + STAT_PAD, DIVIDER_HEIGHT, layout.height - STAT_PAD * 2);
    }

    boxes.forEach((box, i) => drawStatCell(ctx, box, x + i * cell, y, cell, layout));
}

function drawStatCell(ctx: SKRSContext2D, box: StatBox, x: number, y: number, width: number, layout: StatLayout): void {
    const inner = width - STAT_PAD * 2;
    const left = x + STAT_PAD;

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    ctx.fillStyle = LABEL_COLOR;
    ctx.fillText(fitText(ctx, box.label, FONT_REGULAR, layout.labelSize, inner), left, y + layout.labelBaseline);

    if (box.rows) {
        // Caption left, figure right. Rows borrow the value, sub and note
        // baselines so a rows cell lines up with its neighbours — the third
        // lets the detailed time-taken cell carry all three of its lines.
        const baselines = [layout.valueBaseline, layout.subBaseline, layout.noteBaseline];
        const captionSize = Math.round(layout.valueSize * 0.62);
        const figureSize = Math.round(layout.valueSize * 0.7);

        box.rows.forEach(([caption, figure], i) => {
            const baseline = y + baselines[i];

            ctx.fillStyle = LABEL_COLOR;
            ctx.textAlign = 'left';
            ctx.fillText(fitText(ctx, caption, FONT_REGULAR, captionSize, inner * 0.6), left, baseline);

            ctx.fillStyle = VALUE_COLOR;
            ctx.textAlign = 'right';
            ctx.fillText(fitText(ctx, figure, FONT_SEMIBOLD, figureSize, inner * 0.36), x + width - STAT_PAD, baseline);
        });

        ctx.textAlign = 'left';
        return;
    }

    ctx.fillStyle = VALUE_COLOR;
    ctx.fillText(fitText(ctx, box.value, FONT_SEMIBOLD, layout.valueSize, inner), left, y + layout.valueBaseline);

    if (box.sub) {
        ctx.fillStyle = LABEL_COLOR;
        ctx.fillText(fitText(ctx, box.sub, FONT_REGULAR, layout.subSize, inner), left, y + layout.subBaseline);
    }

    // Last line, not squeezed between label and value, so a cell with a note
    // keeps the same baselines as the cells beside it.
    if (box.note) {
        ctx.fillStyle = MUTED_COLOR;
        ctx.fillText(fitText(ctx, box.note, FONT_REGULAR, layout.noteSize, inner), left, y + layout.noteBaseline);
    }
}

/** What each item was bought and sold at, with room for the full name. */
function drawPriceRows(ctx: SKRSContext2D, cardWidth: number, rows: [string, string][], y: number): void {
    ctx.textBaseline = 'alphabetic';
    ctx.font = `${px(26)}px ${FONT_REGULAR}`;
    ctx.fillStyle = LABEL_COLOR;
    ctx.textAlign = 'left';
    ctx.fillText('PRICES', PAD, y + px(24));

    ctx.font = `${px(21)}px ${FONT_REGULAR}`;
    ctx.fillStyle = MUTED_COLOR;
    ctx.textAlign = 'right';
    ctx.fillText('BUY / SELL', cardWidth - PAD, y + px(24));

    rows.forEach(([name, price], i) => {
        const baseline = y + PRICE_HEADER_HEIGHT + PRICE_ROW_HEIGHT * i + px(26);

        ctx.fillStyle = price ? VALUE_COLOR : MUTED_COLOR;
        ctx.textAlign = 'left';
        ctx.fillText(
            fitText(ctx, name, FONT_REGULAR, price ? px(30) : px(27), (cardWidth - PAD * 2) * 0.6),
            PAD,
            baseline
        );

        if (price) {
            ctx.textAlign = 'right';
            ctx.font = `${px(30)}px ${FONT_SEMIBOLD}`;
            ctx.fillText(price, cardWidth - PAD, baseline);
        }
    });

    ctx.textAlign = 'left';
}

/**
 * The glyphs the NotoEmoji subset carries (see assets/fonts/NotoEmoji-Subset.
 * README.txt). Everything else outside Inter's Latin-1 is stripped from a card
 * label, so a custom `customText.*.discordWebhook` can never stall on a glyph
 * the card's backing fonts do not map.
 */
const EMOJI_GLYPHS = new Set([
    0x2b50, 0x2728, 0x1f525, 0x26a1, 0x1f32a, 0x2668, 0x1f4ab, 0x1f4a5, 0x1f300, 0x1f527, 0x1f3a8, 0x1f463, 0x1f50a,
    0x1f383, 0x1f47b
]);

/**
 * A label for the card surface: Discord markdown never belongs there, and nor
 * does a glyph the card's fonts cannot draw. Strip both, lose any trailing
 * colon, uppercase, then fall back when nothing survives. Used for the four
 * `customText.*.discordWebhook` labels the card draws.
 */
export function cardLabel(raw: string, fallback: string): string {
    const markdown = new Set(['*', '_', '`', '~', '|', '[', ']', '(', ')', '>']);
    const kept = Array.from(raw)
        .filter(ch => !markdown.has(ch))
        .filter(ch => {
            const cp = ch.codePointAt(0) ?? 0;
            return cp <= 0xff || EMOJI_GLYPHS.has(cp);
        })
        .join('');

    const cleaned = kept.replace(/:+$/, '').trim().toUpperCase();
    return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * One shared reading → the StatBox the card draws. The readings come from
 * `collectStatReadings`, so the card and the text fallback format the same
 * facts and can never disagree about which `misc.*` toggle gates them.
 */
function boxFromReading(r: StatReading): StatBox {
    switch (r.kind) {
        case 'keyRate':
            return { label: cardLabel(r.label, 'KEY RATE'), value: r.value, sub: r.sub, note: r.note };
        case 'pureStock':
            return { label: cardLabel(r.label, 'PURE STOCK'), value: r.value, sub: r.sub };
        case 'totalItems':
            return { label: cardLabel(r.label, 'TOTAL ITEMS'), value: r.value, sub: r.sub };
        case 'timeTaken':
            return {
                label: cardLabel(r.label, 'TIME TAKEN'),
                // The exact millisecond count reads better as the figure itself
                // in a quarter-width cell than upstream's "(4200 ms)".
                rows: r.rows.map(([caption, figure, ms]) => [caption, r.showMs ? `${ms} ms` : figure])
            };
    }
}

/**
 * The bot-side numbers that used to be embed fields. Each still answers to its
 * own `misc.*` toggle; a disabled one is simply not built and the row reflows.
 */
function buildStatBoxes(bot: Bot, meta: TradeCardMeta): StatBox[] {
    return collectStatReadings(bot, meta).map(boxFromReading);
}

/** Resolve icons with a bounded number of concurrent fetches. */
async function resolveIcons(tiles: TileSpec[], accountName: string, limit: number): Promise<(Image | null)[]> {
    const icons: (Image | null)[] = tiles.map((): Image | null => null);
    let next = 0;

    const workers = Array.from({ length: Math.min(limit, tiles.length) }, async () => {
        for (;;) {
            const i = next++;
            if (i >= tiles.length) {
                return;
            }
            if (tiles[i].kind !== 'item') {
                continue;
            }
            icons[i] = await getItemIcon(tiles[i].sku, accountName);
        }
    });

    await Promise.all(workers);
    return icons;
}

export interface TradeCardOptions {
    /** Defaults to 8, and is clamped to the eight slots the 4x2 grid holds. */
    maxItemsPerSide?: number;
    /** Defaults to on. */
    showQualityBorders?: boolean;
    /** The partner's Steam persona name, drawn in the card's header strip. */
    partnerName?: string;
    /** The partner's Steam avatar URL, clipped to a circle beside the name. */
    partnerAvatarUrl?: string;
}

export interface TradeCardMeta {
    timeTakenToComplete: number;
    timeTakenToProcessOrConstruct?: number;
    timeTakenToCounterOffer?: number;
    isOfferSent?: boolean;
    /**
     * Net overpay in scrap, with the key rate it should be rendered at. Null
     * when the figure is meaningless for this trade (an offer we sent).
     */
    net?: { scrap: number; keyRate: number } | null;
}

/**
 * The partner's header strip: a circular avatar (when one loads) beside the
 * persona name. A dead avatar URL draws the name alone — the same tolerance
 * the emoji font already has, so a missing picture never costs the card.
 */
function drawProfileHeader(
    ctx: SKRSContext2D,
    avatar: Image | null,
    name: string | undefined,
    cardWidth: number
): void {
    const cy = PAD + PROFILE_HEIGHT / 2;
    const cx = PAD + AVATAR_SIZE / 2;

    if (avatar) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, AVATAR_SIZE / 2, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(avatar, PAD, cy - AVATAR_SIZE / 2, AVATAR_SIZE, AVATAR_SIZE);
        ctx.restore();

        // A hairline ring, so the circle still has an edge on light theme.
        ctx.strokeStyle = CARD_BORDER;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, AVATAR_SIZE / 2 - 1, 0, Math.PI * 2);
        ctx.stroke();
    }

    if (!name) {
        return;
    }

    const gap = avatar ? AVATAR_SIZE + PROFILE_GAP : 0;
    const size = px(26);
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = VALUE_COLOR;
    ctx.font = `${size}px ${FONT_SEMIBOLD}`;
    ctx.textAlign = 'left';
    ctx.fillText(fitText(ctx, name, FONT_SEMIBOLD, size, cardWidth - PAD - gap), PAD + gap, cy + px(9));
}

/**
 * Composite the two sides of a trade, plus the bot's own status, into a single PNG.
 *
 * Returns null rather than throwing on any failure — a missing card degrades
 * the summary to text, which is never worth losing a trade notification over.
 */
export default async function renderTradeCard(
    offer: TradeOffer,
    bot: Bot,
    options: TradeCardOptions,
    meta?: TradeCardMeta
): Promise<Buffer | null> {
    try {
        registerTradeCardFonts();

        const dict = offer.data('dict') as ItemsDict;
        if (!dict || !dict.our || !dict.their) {
            return null;
        }

        const value = offer.data('value') as ItemsValue | undefined;
        const keyRate = value?.rate ?? bot.pricelist.getKeyPrice.metal;
        const valueOf = unitValueOf(offer, bot, keyRate);

        // Clamped to the grid: the card has room for TILE_SLOTS a side and no more.
        const maxSlots = Math.max(1, Math.min(TILE_SLOTS, options.maxItemsPerSide ?? TILE_SLOTS));
        const borders = options.showQualityBorders !== false;

        // Attributes the item name cannot carry — spells, parts, killstreak
        // effects, paint — become pictographs on the tile that owns them.
        const highValue = offer.data('highValue') as HighValueOutput | undefined;
        const ourTiles = selectTiles(dict.our, valueOf, maxSlots, collectScanned(highValue?.items?.our));
        const theirTiles = selectTiles(dict.their, valueOf, maxSlots, collectScanned(highValue?.items?.their));

        const accountName = bot.options.steamAccountName;
        const [ourIcons, theirIcons] = await Promise.all([
            resolveIcons(ourTiles, accountName, 6),
            resolveIcons(theirTiles, accountName, 6)
        ]);
        // One small picture, loaded after the tile fans (which run under their
        // own concurrency cap); a slow avatar must not hold the card up.
        const avatar = options.partnerAvatarUrl ? await loadAvatar(options.partnerAvatarUrl) : null;

        // Both of the next two need a Bot wired up far enough to answer for its
        // own state; the render must survive a caller that only has an offer.
        let stats: StatBox[] = [];
        if (meta) {
            try {
                stats = buildStatBoxes(bot, meta);
            } catch (err) {
                log.debug(`Could not build trade card stats for offer #${offer.id}: `, err);
            }
        }

        let priced: PricedItem[] = [];
        try {
            priced = collectPricedItems(offer, bot, keyRate, true);
        } catch (err) {
            log.debug(`Could not collect trade card prices for offer #${offer.id}: `, err);
        }

        const column = COLUMN_WIDTH;
        const cardWidth = CARD_WIDTH;
        // One row when neither side fills it, two when either does.
        const tileRowsHeight = bandHeight(rowsNeeded(ourTiles, theirTiles));
        const theirX = PAD;
        const ourX = PAD + column + COLUMN_GAP;

        const priceLines = priceRows(priced);
        const pricesHeight =
            priceLines.length > 0
                ? BAND_GAP + DIVIDER_HEIGHT + BAND_GAP + PRICE_HEADER_HEIGHT + priceLines.length * PRICE_ROW_HEIGHT
                : 0;
        // The panel's type scales with its cell width, so its height is only
        // known once the card's own width is.
        const statGrid = statLayout(statPanelBox(cardWidth).width, stats.length);
        const statsHeight = stats.length > 0 ? BAND_GAP + DIVIDER_HEIGHT + BAND_GAP + statGrid.height : 0;
        // The header is the card's only place the partner appears when the card
        // itself is absent, so the name stays even when the avatar fails.
        const name = options.partnerName;
        const profileName = name ? name.replace(/[*_`~|>]/g, '').trim() : undefined;
        // A dead avatar URL costs the *picture* alone, never the card, so the
        // strip still stands (name on its own) when loadAvatar returns null.
        const showProfile = Boolean(profileName) || avatar !== null;
        const contentY = PAD + (showProfile ? PROFILE_HEIGHT : 0);
        const height = contentY + tileRowsHeight + pricesHeight + statsHeight + PAD;

        const canvas = createCanvas(cardWidth, height);
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        // Rounded rather than full-bleed: if Discord clips the gallery to its own
        // radius these corners fall inside the clip and cost nothing; if it does
        // not, the card has soft corners instead of four hard points.
        ctx.fillStyle = CARD_BG;
        roundedRect(ctx, 0, 0, cardWidth, height, CARD_RADIUS);
        ctx.fill();

        // A hairline edge, so the card still reads as a card on dark theme.
        ctx.strokeStyle = CARD_BORDER;
        ctx.lineWidth = 2;
        roundedRect(ctx, 1, 1, cardWidth - 2, height - 2, CARD_RADIUS - 1);
        ctx.stroke();

        if (showProfile) {
            drawProfileHeader(ctx, avatar, profileName, cardWidth);
        }

        const ourValue = value?.our ? new Currencies(value.our).toString() : '';
        const theirValue = value?.their ? new Currencies(value.their).toString() : '';

        // The surplus gets the only colour on an otherwise grey card.
        const net = meta?.net;
        const delta =
            net && net.scrap !== 0
                ? {
                      text: `${net.scrap > 0 ? '+' : '-'}${Currencies.toCurrencies(
                          Math.round(Math.abs(net.scrap)),
                          net.keyRate
                      ).toString()}`,
                      positive: net.scrap > 0
                  }
                : undefined;

        // What came in reads left, what it cost reads right. The delta chip stays
        // with their total, since the surplus is what they paid over our asking price.
        drawBand(ctx, theirX, column, 'They Sent', theirValue, theirTiles, theirIcons, contentY, borders, delta);
        drawBand(ctx, ourX, column, 'For Our', ourValue, ourTiles, ourIcons, contentY, borders);

        // A vertical rule between the columns, inset to the tile row so it reads
        // as separating the two sides rather than cutting the whole card in half.
        ctx.fillStyle = DIVIDER_COLOR;
        ctx.fillRect(PAD + column + COLUMN_GAP / 2, contentY, DIVIDER_HEIGHT, tileRowsHeight);

        // Each remaining section owns a divider above itself, so the card reflows
        // when one of them is absent rather than leaving a gap where it was.
        let sectionY = contentY + tileRowsHeight;

        const divide = (): number => {
            ctx.fillStyle = DIVIDER_COLOR;
            ctx.fillRect(PAD, sectionY + BAND_GAP, cardWidth - PAD * 2, DIVIDER_HEIGHT);

            return sectionY + BAND_GAP + DIVIDER_HEIGHT + BAND_GAP;
        };

        if (priceLines.length > 0) {
            drawPriceRows(ctx, cardWidth, priceLines, divide());
            sectionY += pricesHeight;
        }

        if (stats.length > 0) {
            drawStatPanel(ctx, cardWidth, stats, divide(), statGrid);
        }

        return canvas.toBuffer('image/png');
    } catch (err) {
        log.warn(`Could not render trade card for offer #${offer.id}: `, err);
        return null;
    }
}
