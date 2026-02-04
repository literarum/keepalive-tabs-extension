import { DEFAULT_STATE, STORAGE_KEY } from './defaults.js';

/**
 * Надёжное хранилище состояния с “мьютексом” на запись.
 * - getState(): возвращает слитое DEFAULT_STATE + данные из storage
 * - update(mutator): атомарная запись на основе текущего состояния
 */
export class StateStore {
    /** @param {"local"|"sync"} area */
    constructor(area = 'local') {
        this.area = area;
        this._writing = Promise.resolve();
        this._listeners = new Set();

        chrome.storage[this.area].onChanged?.addListener?.(() => {});
        chrome.storage.onChanged.addListener((changes, areaName) => {
            if (areaName !== this.area) return;
            if (!changes[STORAGE_KEY]) return;
            for (const cb of this._listeners) cb();
        });
    }

    /** @returns {Promise<any>} */
    async getState() {
        const raw = await this._getRaw();
        return this._merge(DEFAULT_STATE, raw ?? {});
    }

    /**
     * @param {(draft:any)=>void|any} mutator
     * @returns {Promise<any>} nextState
     */
    async update(mutator) {
        // сериализуем записи
        this._writing = this._writing.then(async () => {
            const current = await this.getState();
            const draft = structuredClone(current);
            const maybeReturn = mutator(draft);
            const next = maybeReturn && typeof maybeReturn === 'object' ? maybeReturn : draft;

            // маленькая “санитария”
            next.settings.healthIntervalSec = Math.max(
                60,
                Number(next.settings.healthIntervalSec || 60),
            );

            await this._setRaw(next);
            return next;
        });

        return this._writing;
    }

    /** @param {() => void} cb */
    subscribe(cb) {
        this._listeners.add(cb);
        return () => this._listeners.delete(cb);
    }

    // ---------- private ----------

    async _getRaw() {
        return new Promise((resolve) => {
            chrome.storage[this.area].get([STORAGE_KEY], (obj) => {
                resolve(obj?.[STORAGE_KEY]);
            });
        });
    }

    /** @param {any} value */
    async _setRaw(value) {
        return new Promise((resolve, reject) => {
            chrome.storage[this.area].set({ [STORAGE_KEY]: value }, () => {
                const err = chrome.runtime.lastError;
                if (err) reject(new Error(err.message));
                else resolve();
            });
        });
    }

    _merge(base, extra) {
        // безопасное глубокое слияние без прототипов
        const out = Array.isArray(base) ? [...base] : { ...base };
        for (const [k, v] of Object.entries(extra || {})) {
            if (
                v &&
                typeof v === 'object' &&
                !Array.isArray(v) &&
                base?.[k] &&
                typeof base[k] === 'object'
            ) {
                out[k] = this._merge(base[k], v);
            } else {
                out[k] = v;
            }
        }
        return out;
    }
}
