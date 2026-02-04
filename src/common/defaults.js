import { Id } from './ids.js';

export const STORAGE_KEY = 'keepalive_state_v1';

/**
 * Настройки по умолчанию.
 * Важно: chrome.alarms стабильно работает с периодом >= 1 минуты,
 * поэтому healthIntervalSec минимум 60.
 */
export const DEFAULT_STATE = Object.freeze({
    schemaVersion: 1,

    settings: {
        enabled: true,
        keepPinnedAlive: true,
        autoRestoreDiscarded: true,
        preventAutoDiscardable: true,
        autoLearnPinned: true,

        // clamp >= 60
        healthIntervalSec: 60,

        // глобальный дефолт логина (может быть переопределён правилом сайта)
        autoLoginMode: 'off', // "off" | "autofill" | "telegram"

        // если false — не перезагружать вкладку при "не готова", только отметить
        aggressiveReloadOnUnhealthy: false,
    },

    /**
     * Правила сайтов. Это НЕ “вкладки”, это настройки поведения по шаблону URL.
     * match: простой wildcard (*)
     */
    siteRules: [
        {
            id: Id.uuid(),
            enabled: true,
            name: '1cservices (пример)',
            match: 'https://1cservices.keydisk.ru/*',
            readinessSelector: 'body',
            loginMode: 'telegram',
            // Клик по своей кнопке (если НЕ iframe). Если на сайте только iframe-виджет,
            // расширение не сможет кликнуть “внутрь” iframe — покажем статус.
            clickSelectors: [
                '[data-telegram-login]',
                "button[data-qa*='telegram']",
                "button[class*='telegram']",
                "a[href*='telegram']",
            ],
        },
    ],

    /**
     * “База закреплённых вкладок” — хранится по urlKey.
     * pinnedEntries: Record<urlKey, Entry>
     */
    pinnedEntries: {},
});
