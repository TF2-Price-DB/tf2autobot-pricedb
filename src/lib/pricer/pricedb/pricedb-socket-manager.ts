import { io, Socket } from 'socket.io-client';
import { EventEmitter } from 'events';
import log from '../../logger';

export default class PriceDbSocketManager extends EventEmitter {
    private socket: Socket | null = null;

    private readonly maxReconnectAttempts = 3;

    private readonly maxReconnectDelay = 30000;

    private reconnectAttempts = 0;

    private reconnectDelay = 1000;

    private shouldReconnect = true;

    public isConnecting = false;

    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    // Price update batching for logging
    private priceUpdateCount = 0;

    private lastPriceLogTime = Date.now();

    private readonly priceLogIntervalMs = 30000; // Log summary every 30 seconds

    private priceLogTimer: ReturnType<typeof setTimeout> | null = null;

    private recentPriceUpdates: string[] = []; // Store recent SKUs for summary

    private readonly maxRecentPrices = 5; // Show max 5 recent price SKUs in summary

    constructor(
        private readonly url: string = 'ws://ws.pricedb.io/',
        private readonly urlTLS: string = 'wss://ws.pricedb.io/'
    ) {
        super();
    }

    connect(preferTLS = false, force = false): void {
        if (this.socket?.connected && !force) {
            log.debug(`PriceDB socket already connected.`);
            return;
        }

        if (!force && this.isConnecting) {
            log.debug('Already trying to connect to PriceDB...');
            return;
        }

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.socket) {
            try {
                this.socket.removeAllListeners();
                this.socket.disconnect();
            } catch (e) {
                log.warn('Error while cleaning previous socket:', e);
            }
            this.socket = null;
        }

        this.isConnecting = true;
        const endpoint = preferTLS ? this.urlTLS : this.url;
        log.debug(`Connecting to PriceDB WebSocket ${preferTLS ? '[TLS]' : ''} ${endpoint}...`);

        this.socket = io(endpoint, {
            transports: ['websocket'],
            timeout: 10000,
            reconnection: false,
            autoConnect: true
        });

        this.socket.on('connect', () => {
            log.debug(`✅ Connected to PriceDB ${preferTLS ? '[TLS]' : ''} ${endpoint}`);
            this.isConnecting = false;
            this.reconnectAttempts = 0;
            this.emit('connected');
        });

        this.socket.on('disconnect', reason => {
            log.debug(`Disconnected from PriceDB ${preferTLS ? '[TLS]' : ''} WebSocket: ${reason}`);
            this.isConnecting = false;
            this.emit('disconnected', reason);

            if (this.shouldReconnect) {
                this.scheduleReconnect(preferTLS);
            }
        });

        this.socket.on('connect_error', error => {
            log.warn(`PriceDB WebSocket ${preferTLS ? '[TLS]' : ''} connection error:`, error);
            this.isConnecting = false;

            if (this.shouldReconnect) {
                this.scheduleReconnect(preferTLS);
            }
        });

        this.socket.on('price', data => {
            this.handlePriceUpdate(data);
            this.emit('price', data);
        });
    }

    private handlePriceUpdate(data: any): void {
        this.priceUpdateCount++;

        // Track recent price updates for summary
        if (data.sku && this.recentPriceUpdates.length < this.maxRecentPrices) {
            if (!this.recentPriceUpdates.includes(data.sku)) {
                this.recentPriceUpdates.push(data.sku);
            }
        }

        // Log summary periodically instead of every update
        const now = Date.now();
        if (now - this.lastPriceLogTime >= this.priceLogIntervalMs) {
            this.logPriceUpdateSummary();
        } else if (!this.priceLogTimer) {
            // Schedule a summary log if not already scheduled
            this.priceLogTimer = setTimeout(() => {
                this.logPriceUpdateSummary();
            }, this.priceLogIntervalMs);
        }
    }

    private logPriceUpdateSummary(): void {
        if (this.priceUpdateCount > 0) {
            const recentSkus =
                this.recentPriceUpdates.length > 0
                    ? ` (recent: ${this.recentPriceUpdates.join(', ')}${
                          this.recentPriceUpdates.length >= this.maxRecentPrices ? ', ...' : ''
                      })`
                    : '';

            log.debug(`Received ${this.priceUpdateCount} price updates from PriceDB${recentSkus}`);

            // Reset counters
            this.priceUpdateCount = 0;
            this.recentPriceUpdates = [];
            this.lastPriceLogTime = Date.now();
        }

        if (this.priceLogTimer) {
            clearTimeout(this.priceLogTimer);
            this.priceLogTimer = null;
        }
    }

    private scheduleReconnect(preferTLS: boolean): void {
        if (!this.shouldReconnect) return;
        if (this.reconnectTimer) return;

        this.reconnectAttempts += 1;

        if (this.reconnectAttempts > this.maxReconnectAttempts) {
            this.reconnectAttempts = 0;

            if (preferTLS) {
                log.error('Max reconnect attempts reached for PriceDB (both protocols tried).');
                this.reconnectAttempts = 0;
                return;
            }

            log.warn('Max non-TLS reconnect attempts reached, falling back to TLS endpoint.');
            this.reconnectAttempts = 0;
            this.reconnectTimer = setTimeout(() => {
                this.reconnectTimer = null;
                if (!this.shouldReconnect) return;
                this.connect(true, true);
            }, 500);

            return;
        }

        let delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
        if (delay > this.maxReconnectDelay) {
            delay = this.maxReconnectDelay;
        }

        log.debug(
            `Attempting to reconnect to PriceDB ${preferTLS ? '[TLS]' : ''} in ${delay}ms (attempt ${
                this.reconnectAttempts
            }/${this.maxReconnectAttempts})`
        );

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (!this.shouldReconnect) return;
            this.connect(preferTLS, true);
        }, delay);
    }

    disconnect(): void {
        this.shouldReconnect = false;
        this.isConnecting = false;
        this.reconnectAttempts = 0;

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.priceLogTimer) {
            clearTimeout(this.priceLogTimer);
            this.priceLogTimer = null;
        }

        // Log any remaining price updates before disconnecting
        if (this.priceUpdateCount > 0) {
            this.logPriceUpdateSummary();
        }

        if (this.socket) {
            try {
                this.socket.removeAllListeners();
                this.socket.disconnect();
            } catch (e) {
                log.warn('Error while disconnecting socket:', e);
            }
            this.socket = null;
        }
    }

    init(): void {
        this.shouldReconnect = true;
        this.connect(false);
    }

    shutdown(): void {
        this.disconnect();
    }
}
