import { io, Socket } from 'socket.io-client';
import { EventEmitter } from 'events';
import log from '../../logger';

export default class PriceDbSocketManager extends EventEmitter {
    private socket: Socket | null = null;

    private reconnectAttempts = 0;
    private maxReconnectAttempts = 3;
    private reconnectDelay = 1000;
    private maxReconnectDelay = 30000;

    private shouldReconnect = true;
    public isConnecting = false;

    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        private readonly url: string = 'ws://ws.pricedb.io/',
        private readonly urlTLS: string = 'wss://ws.pricedb.io/'
    ) {
        super();
    }

    connect(preferTLS = false, force = false): void {
        if (this.socket && this.socket.connected && !force) {
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
            timeout: 10_000,
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
            log.debug('Received price update from PriceDB:', data);
            this.emit('price', data);
        });
    }

    private scheduleReconnect(preferTLS: boolean): void {
        if (!this.shouldReconnect) return;
        if (this.reconnectTimer) return;

        this.reconnectAttempts += 1;

        if (this.reconnectAttempts > this.maxReconnectAttempts) {
            if (!preferTLS) {
                log.warn('Max non-TLS reconnect attempts reached, falling back to TLS endpoint.');
                this.reconnectAttempts = 0;
                this.reconnectTimer = setTimeout(() => {
                    this.reconnectTimer = null;
                    if (!this.shouldReconnect) return;
                    this.connect(true, true);
                }, 500);
                return;
            } else {
                log.error('Max reconnect attempts reached for PriceDB (both protocols tried).');
                this.reconnectAttempts = 0;
                return;
            }
        }

        let delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
        if (delay > this.maxReconnectDelay) delay = this.maxReconnectDelay;

        log.debug(
            `Attempting to reconnect to PriceDB ${preferTLS ? '[TLS]' : ''} in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`
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
