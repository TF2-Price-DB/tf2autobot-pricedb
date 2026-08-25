import { createCanvas } from '@napi-rs/canvas';
import { getItemIcon } from './itemImageCache';
import { registerTradeCardFonts } from './renderTradeCard';
import {
    CARD_BG,
    CARD_BORDER,
    FONT_REGULAR,
    FONT_SEMIBOLD,
    PILL_TEXT,
    roundedRect,
    TILE_FILL,
    fitText
} from './cardCanvas';
import { stockCardBorderColor } from './renderStockCards';

/** Render the concise, single-item card used by the Discord !price command. */
export default async function renderPriceCard(
    sku: string,
    name: string,
    buy: string,
    sell: string,
    stock: number,
    limits: string,
    intent: string,
    autoprice: boolean,
    updated: string | undefined,
    accountName: string,
    showQualityBorders: boolean
): Promise<Buffer | null> {
    try {
        registerTradeCardFonts();
        const icon = await getItemIcon(sku, accountName);
        const width = 960;
        const height = 350;
        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = CARD_BG;
        roundedRect(ctx, 0, 0, width, height, 24);
        ctx.fill();
        ctx.strokeStyle = CARD_BORDER;
        ctx.lineWidth = 2;
        ctx.stroke();
        roundedRect(ctx, 24, 76, 272, 240, 18);
        ctx.fillStyle = TILE_FILL;
        ctx.fill();
        ctx.strokeStyle = showQualityBorders ? stockCardBorderColor(sku) : CARD_BORDER;
        ctx.lineWidth = showQualityBorders ? 3 : 2;
        ctx.stroke();
        if (icon) ctx.drawImage(icon, 60, 104, 200, 200);
        ctx.fillStyle = PILL_TEXT;
        ctx.font = `26px ${FONT_SEMIBOLD}`;
        ctx.textAlign = 'left';
        ctx.fillText('PRICE CHECK', 24, 45);
        ctx.font = `18px ${FONT_REGULAR}`;
        ctx.fillStyle = '#B8BEC9';
        ctx.textAlign = 'right';
        ctx.fillText(`SKU ${sku}`, width - 24, 44);
        ctx.fillStyle = PILL_TEXT;
        ctx.font = `30px ${FONT_SEMIBOLD}`;
        ctx.textAlign = 'left';
        ctx.fillText(fitText(ctx, name, FONT_SEMIBOLD, 30, 600), 330, 115);
        const rows = [
            ['BUY', buy],
            ['SELL', sell],
            ['STOCK', `${stock} tradable`],
            ['LIMITS', limits],
            ['INTENT', intent],
            ['PRICE', autoprice ? `Autoprice${updated ? ` · ${updated}` : ''}` : 'Manual']
        ];
        rows.forEach(([label, value], index) => {
            const y = 154 + index * 30;
            ctx.font = `17px ${FONT_SEMIBOLD}`;
            ctx.fillStyle = '#9AA9BE';
            ctx.fillText(label, 330, y);
            ctx.font = `19px ${FONT_REGULAR}`;
            ctx.fillStyle = PILL_TEXT;
            ctx.fillText(fitText(ctx, value, FONT_REGULAR, 19, 470), 450, y);
        });
        return canvas.toBuffer('image/png');
    } catch {
        return null;
    }
}
