import { createCanvas, SKRSContext2D } from '@napi-rs/canvas';
import Currencies from '@tf2autobot/tf2-currencies';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
dayjs.extend(utc);
dayjs.extend(timezone);
import {
    CARD_BG,
    CARD_BORDER,
    FONT_REGULAR,
    FONT_SEMIBOLD,
    LOSS_COLOR,
    PILL_TEXT,
    PROFIT_COLOR,
    roundedRect,
    TILE_FILL
} from './cardCanvas';
import { registerTradeCardFonts } from './renderTradeCard';
import { outcomePanelCells, type StatsReadings } from './statsFacts';

const WIDTH = 960;
const HEIGHT = 520;
const MUTED = '#B8BEC9';
const LABEL = '#9AA9BE';
const PROFIT_FILL = 'rgba(20, 60, 35, 0.55)';
const LOSS_FILL = 'rgba(70, 22, 24, 0.55)';
const ZERO_LINE = 'rgba(255, 255, 255, 0.22)';
const HAIRLINE = 'rgba(255, 255, 255, 0.10)';

export default async function renderStatsCard(readings: StatsReadings): Promise<Buffer | null> {
    try {
        registerTradeCardFonts();

        const height = HEIGHT;
        const canvas = createCanvas(WIDTH, height);
        const ctx = canvas.getContext('2d');

        ctx.fillStyle = CARD_BG;
        roundedRect(ctx, 0, 0, WIDTH, height, 24);
        ctx.fill();
        ctx.strokeStyle = CARD_BORDER;
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = PILL_TEXT;
        ctx.font = `26px ${FONT_SEMIBOLD}`;
        ctx.fillText('STATISTICS', 28, 42);

        ctx.fillStyle = MUTED;
        ctx.font = `18px ${FONT_REGULAR}`;
        ctx.fillText(
            `Tracked for ${readings.totalDays} days · ${readings.totalAccepted} accepted trades`,
            28,
            68
        );

        drawProfitRow(ctx, readings);

        const showPlot = readings.series.some(day => Math.abs(day.convertedScrap) > 0);
        if (showPlot) {
            drawDailyLine(ctx, readings, 196, 148);
        }

        drawOutcomePanel(ctx, readings, 404);

        return canvas.toBuffer('image/png');
    } catch {
        return null;
    }
}

function drawProfitRow(ctx: SKRSContext2D, readings: StatsReadings): void {
    const left = 28;
    const midX = WIDTH / 2;
    const rightCol = midX + 24;
    const valueY = 136;
    const hintY = 166;
    const rate = `${readings.keySell} ref/key`;

    ctx.strokeStyle = HAIRLINE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(midX, 96);
    ctx.lineTo(midX, 174);
    ctx.stroke();

    drawProfitColumn(
        ctx,
        left,
        '24H',
        formatRaw(readings.raw24h.keys, readings.raw24h.metal),
        readings.converted24h,
        readings.converted24hScrap >= 0,
        rate,
        valueY,
        hintY
    );
    drawProfitColumn(
        ctx,
        rightCol,
        'ALL-TIME',
        formatRaw(readings.rawAll.keys, readings.rawAll.metal),
        readings.convertedAll,
        readings.convertedAllScrap >= 0,
        rate,
        valueY,
        hintY
    );
}

function drawProfitColumn(
    ctx: SKRSContext2D,
    x: number,
    title: string,
    raw: string,
    converted: string,
    positive: boolean,
    rate: string,
    valueY: number,
    hintY: number
): void {
    const colWidth = (x < WIDTH / 2 ? WIDTH / 2 - 8 : WIDTH - 28) - x - 8;

    ctx.fillStyle = LABEL;
    ctx.font = `15px ${FONT_SEMIBOLD}`;
    ctx.textAlign = 'left';
    ctx.fillText(title, x, 104);

    let fontSize = 20;
    let rawWidth: number;
    let chipWidth: number;
    do {
        ctx.font = `${fontSize}px ${FONT_SEMIBOLD}`;
        rawWidth = ctx.measureText(raw).width;
        ctx.font = `${Math.round(fontSize * 0.83)}px ${FONT_SEMIBOLD}`;
        chipWidth = ctx.measureText(converted).width + 20;
        if (rawWidth + 12 + chipWidth > colWidth) fontSize -= 1;
    } while (rawWidth + 12 + chipWidth > colWidth && fontSize > 11);

    ctx.fillStyle = PILL_TEXT;
    ctx.font = `${fontSize}px ${FONT_SEMIBOLD}`;
    ctx.fillText(raw, x, valueY);
    const chipX = x + rawWidth + 12;
    chipWidth = drawDeltaChip(ctx, chipX, valueY, converted, positive);

    ctx.fillStyle = LABEL;
    ctx.font = `12px ${FONT_REGULAR}`;
    ctx.fillText('RAW  keys + metal as booked', x, hintY);
    ctx.textAlign = 'center';
    ctx.fillText(`CONVERTED  at ${rate}`, chipX + chipWidth / 2, hintY);
    ctx.textAlign = 'left';
}

function drawDailyLine(ctx: SKRSContext2D, readings: StatsReadings, y: number, plotHeight: number): void {
    const scraps = readings.series.map(day => day.convertedScrap);
    const maxPositive = Math.max(...scraps.filter(s => s > 0), 0);
    const maxNegative = Math.min(...scraps.filter(s => s < 0), 0);
    const topScale = maxPositive || 1;
    const bottomScale = Math.abs(maxNegative) || 1;
    const labelWidth = 80;
    const plotX = 28 + labelWidth;
    const plotW = WIDTH - 28 - plotX;
    const zeroY = y + plotHeight / 2;
    const half = plotHeight / 2 - 18;
    const slot = plotW / Math.max(readings.series.length, 1);

    ctx.fillStyle = TILE_FILL;
    roundedRect(ctx, plotX, y, plotW, plotHeight, 12);
    ctx.fill();

    ctx.strokeStyle = ZERO_LINE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotX + 8, zeroY);
    ctx.lineTo(plotX + plotW - 8, zeroY);
    ctx.stroke();

    const points = readings.series.map((day, index) => {
        const s = day.convertedScrap;
        const py = s >= 0 ? zeroY - (s / topScale) * half : zeroY + (Math.abs(s) / bottomScale) * half;
        return { x: plotX + slot * index + slot / 2, y: py, scrap: s };
    });

    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'miter';
    ctx.lineCap = 'round';
    for (let i = 0; i < points.length - 1; i++) {
        const a = points[i];
        const b = points[i + 1];
        const crosses = (a.scrap > 0 && b.scrap < 0) || (a.scrap < 0 && b.scrap > 0);
        if (crosses) {
            const t = Math.abs(a.scrap) / (Math.abs(a.scrap) + Math.abs(b.scrap));
            const zx = a.x + (b.x - a.x) * t;
            strokeSeg(ctx, a.x, a.y, zx, zeroY, a.scrap >= 0);
            strokeSeg(ctx, zx, zeroY, b.x, b.y, b.scrap >= 0);
        } else {
            strokeSeg(ctx, a.x, a.y, b.x, b.y, a.scrap + b.scrap >= 0);
        }
    }

    points.forEach(point => {
        ctx.beginPath();
        ctx.arc(point.x, point.y, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = point.scrap > 0 ? PROFIT_COLOR : point.scrap < 0 ? LOSS_COLOR : MUTED;
        ctx.fill();
    });

    ctx.fillStyle = MUTED;
    ctx.font = `13px ${FONT_REGULAR}`;
    ctx.textAlign = 'right';
    const posLabel = Number.isInteger(Currencies.toRefined(topScale))
        ? String(Currencies.toRefined(topScale))
        : Currencies.toRefined(topScale).toFixed(2);
    const negLabel = Number.isInteger(Currencies.toRefined(bottomScale))
        ? String(Currencies.toRefined(bottomScale))
        : Currencies.toRefined(bottomScale).toFixed(2);
    if (maxPositive > 0) ctx.fillText(`+${posLabel} ref`, plotX - 6, y + 16);
    if (maxNegative < 0) ctx.fillText(`−${negLabel} ref`, plotX - 6, y + plotHeight - 4);

    const tickCount = 5;
    ctx.textAlign = 'center';
    ctx.font = `12px ${FONT_REGULAR}`;
    for (let i = 0; i < tickCount; i++) {
        const idx = Math.round((readings.series.length - 1) * (i / (tickCount - 1)));
        const day = readings.series[idx];
        if (!day) continue;
        const label = dayjs(day.startMs).format('DD/MM');
        ctx.fillText(label, plotX + slot * idx + slot / 2, y + plotHeight + 18);
    }
    ctx.textAlign = 'left';
}

function strokeSeg(
    ctx: SKRSContext2D,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    positive: boolean
): void {
    ctx.strokeStyle = positive ? PROFIT_COLOR : LOSS_COLOR;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
}

function drawOutcomePanel(ctx: SKRSContext2D, readings: StatsReadings, y: number): void {
    const x = 28;
    const width = WIDTH - 56;
    const height = 104;
    const cells = outcomePanelCells(readings);

    ctx.fillStyle = TILE_FILL;
    roundedRect(ctx, x, y, width, height, 16);
    ctx.fill();

    const cellW = width / cells.length;
    ctx.strokeStyle = HAIRLINE;
    ctx.lineWidth = 1;
    for (let i = 1; i < cells.length; i++) {
        const hx = x + cellW * i;
        ctx.beginPath();
        ctx.moveTo(hx, y + 14);
        ctx.lineTo(hx, y + height - 14);
        ctx.stroke();
    }

    cells.forEach((cell, index) => {
        const cx = x + cellW * index + cellW / 2;
        ctx.textAlign = 'center';
        ctx.fillStyle = LABEL;
        ctx.font = `13px ${FONT_SEMIBOLD}`;
        ctx.fillText(cell.label, cx, y + 28);
        ctx.fillStyle = PILL_TEXT;
        ctx.font = `22px ${FONT_SEMIBOLD}`;
        ctx.fillText(cell.value, cx, y + 56);
        ctx.fillStyle = LABEL;
        ctx.font = `13px ${FONT_REGULAR}`;
        ctx.fillText(cell.hint, cx, y + 80);
    });
    ctx.textAlign = 'left';
}

function drawDeltaChip(
    ctx: SKRSContext2D,
    left: number,
    baseline: number,
    text: string,
    positive: boolean
): number {
    ctx.font = `20px ${FONT_SEMIBOLD}`;
    const textWidth = ctx.measureText(text).width;
    const chipWidth = textWidth + 20;
    const chipHeight = 30;
    const chipY = baseline - chipHeight + 8;

    ctx.fillStyle = positive ? PROFIT_FILL : LOSS_FILL;
    roundedRect(ctx, left, chipY, chipWidth, chipHeight, chipHeight / 2);
    ctx.fill();

    ctx.strokeStyle = positive ? PROFIT_COLOR : LOSS_COLOR;
    ctx.lineWidth = 1.5;
    roundedRect(ctx, left + 0.75, chipY + 0.75, chipWidth - 1.5, chipHeight - 1.5, chipHeight / 2);
    ctx.stroke();

    ctx.fillStyle = positive ? PROFIT_COLOR : LOSS_COLOR;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, left + chipWidth / 2, chipY + chipHeight / 2 + 1);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    return chipWidth;
}

function formatRaw(keys: number, metal: number): string {
    if (keys !== 0) {
        return `${signed(keys)} keys, ${signed(metal, 2)} ref`;
    }
    return `${signed(metal, 2)} ref`;
}

function signed(value: number, digits?: number): string {
    const body = digits === undefined ? String(value) : value.toFixed(digits);
    return value > 0 ? `+${body}` : body;
}

