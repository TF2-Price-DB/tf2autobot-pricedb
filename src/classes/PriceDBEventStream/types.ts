export type HeartBeatEventEnvelope = object;

export type TradeRequestEventEnvelope = {
    kind: string;
    trade_request?: TradeRequestPayload;
};

export type TradeRequestPayload = {
    trade_offer_url: string;
    items_to_give: TradeRequestItem[];
    items_to_receive: TradeRequestItem[];
    reserved_assets: string[];
};

export type TradeRequestSkuItem = {
    kind: 'sku';
    sku: string;
    amount: number;
};

export type TradeRequestAssetIdItem = {
    kind: 'assetid';
    assetid: string;
};

export type TradeRequestItem = TradeRequestSkuItem | TradeRequestAssetIdItem;
