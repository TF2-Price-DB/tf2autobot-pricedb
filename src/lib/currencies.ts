import TF2Currencies from '@tf2autobot/tf2-currencies';

export default class Currencies extends TF2Currencies {
    static toHalfScrap(refined: number): number {
        return this.toScrap(refined) * 2;
    }
}
