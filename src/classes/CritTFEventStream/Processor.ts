export interface Handler<T> {
    process(t: T): Promise<void> | void;
}
