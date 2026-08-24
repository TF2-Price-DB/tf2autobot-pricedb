import { Image, SKRSContext2D } from '@napi-rs/canvas';

export const CARD_BG = '#2F3136';
export const CARD_BORDER = 'rgba(255, 255, 255, 0.09)';
export const TILE_FILL = 'rgba(255, 255, 255, 0.06)';
export const PILL_FILL = 'rgba(0, 0, 0, 0.72)';
export const PILL_TEXT = '#FFFFFF';
export const FONT_REGULAR = 'TradeCardSans';
export const FONT_SEMIBOLD = 'TradeCardSansSemi';
export const PROFIT_COLOR = '#57F287';
export const LOSS_COLOR = '#FF6B6E';

export function roundedRect(
    ctx: SKRSContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number
): void {
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, radius);
}

export function drawIcon(ctx: SKRSContext2D, icon: Image | null, x: number, y: number, size: number): void {
    if (icon === null) return;

    const scale = Math.min(size / icon.width, size / icon.height);
    const width = icon.width * scale;
    const height = icon.height * scale;
    ctx.drawImage(icon, x + (size - width) / 2, y + (size - height) / 2, width, height);
}

export function drawCountPill(
    ctx: SKRSContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    amount: number,
    position: 'top' | 'bottom' = 'bottom'
): void {
    const label = `x${amount}`;
    ctx.font = `22px ${FONT_SEMIBOLD}`;
    const pillWidth = ctx.measureText(label).width + 20;
    const pillHeight = 34;
    const pillX = x + width - pillWidth - 12;
    const pillY = position === 'top' ? y + 12 : y + height - pillHeight - 12;

    ctx.fillStyle = PILL_FILL;
    roundedRect(ctx, pillX, pillY, pillWidth, pillHeight, pillHeight / 2);
    ctx.fill();
    ctx.fillStyle = PILL_TEXT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, pillX + pillWidth / 2, pillY + pillHeight / 2 + 1);
}

export function fitText(ctx: SKRSContext2D, text: string, font: string, size: number, maxWidth: number): string {
    let result = text;
    ctx.font = `${size}px ${font}`;
    while (result.length > 1 && ctx.measureText(`${result}…`).width > maxWidth) result = result.slice(0, -1);
    return result === text ? text : `${result.trimEnd()}…`;
}
