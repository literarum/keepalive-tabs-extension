import { StateStore } from '../common/storage.js';
import { Url } from '../common/url.js';
import { RuleEngine } from '../common/rules.js';
import { MSG } from '../common/messages.js';
import { Id } from '../common/ids.js';

function logFatal(err) {
    console.error('[KeepAliveTabs] service worker fatal:', err);
}

self.addEventListener('unhandledrejection', (e) => logFatal(e?.reason));
self.addEventListener('error', (e) => logFatal(e?.error || e?.message));

const ALARM_NAME = 'keepalive_tick';

class KeepAliveService {
    constructor() {
        this.store = new StateStore('local');
        this._cycleInFlight = false;

        // чтобы не устраивать вечные перезагрузки:
        /** @type {Map<number, number>} tabId -> lastReloadTs */
        this._reloadCooldown = new Map();
    }

    async init() {
        await this._ensureAlarm();

        chrome.alarms.onAlarm.addListener((alarm) => {
            if (alarm?.name === ALARM_NAME) this.runCycle('alarm');
        });

        chrome.runtime.onStartup.addListener(() => this.runCycle('startup'));
        chrome.runtime.onInstalled.addListener(({ reason }) => {
            if (reason === 'install') chrome.runtime.openOptionsPage();
            this.runCycle('installed');
        });

        chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
            if (changeInfo?.status === 'complete' && Url.isHttp(tab.url)) {
                const state = await this.store.getState();
                const urlKey = Url.toUrlKey(tab.url);
                const isTrackedInDb =
                    state.pinnedEntries[urlKey] && state.pinnedEntries[urlKey].enabled;

                if (tab.pinned || isTrackedInDb) {
                    this._touchPinnedFromTab(tab).catch(() => {});
                    this.runCycle('tab_complete').catch(() => {});
                }
            }
        });

        chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
            this._onMessage(msg, sender)
                .then((res) => sendResponse(res))
                .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
            return true;
        });
    }

    async _ensureAlarm() {
        const state = await this.store.getState();
        const sec = Math.max(60, Number(state.settings.healthIntervalSec || 60));
        const minutes = Math.max(1, sec / 60);

        await new Promise((resolve) => {
            chrome.alarms.create(ALARM_NAME, { periodInMinutes: minutes });
            resolve();
        });
    }

    async runCycle(reason = 'manual') {
        if (this._cycleInFlight) return;
        this._cycleInFlight = true;

        try {
            const state = await this.store.getState();
            if (!state.settings.enabled) return;

            const allTabs = await new Promise((resolve) => chrome.tabs.query({}, resolve));
            const httpTabs = allTabs.filter((t) => Url.isHttp(t.url));

            const targetTabs = httpTabs.filter((tab) => {
                if (tab.pinned) return true;

                const urlKey = Url.toUrlKey(tab.url);
                const entry = state.pinnedEntries[urlKey];
                return entry && entry.enabled;
            });

            if (state.settings.autoLearnPinned) {
                const realPinnedTabs = targetTabs.filter((t) => t.pinned);
                await this._learnPinnedTabs(state, realPinnedTabs);
            }

            if (state.settings.keepPinnedAlive) {
                await this._keepTabsAlive(state, targetTabs);
            }

            await this.store.update((draft) => {
                draft._runtime = draft._runtime || {};
                draft._runtime.lastCycleAt = Date.now();
                draft._runtime.lastCycleReason = reason;
            });
        } finally {
            this._cycleInFlight = false;
        }
    }

    async _learnPinnedTabs(state, pinnedTabs) {
        const now = Date.now();
        await this.store.update((draft) => {
            for (const tab of pinnedTabs) {
                const urlKey = Url.toUrlKey(tab.url);
                if (!draft.pinnedEntries[urlKey]) {
                    draft.pinnedEntries[urlKey] = {
                        id: Id.uuid(),
                        urlKey,
                        url: tab.url,
                        titleHint: tab.title || Url.hostname(tab.url) || 'Закреплённая вкладка',
                        enabled: true,
                        createdAt: now,
                        updatedAt: now,
                        lastSeenTabId: tab.id,
                        lastHealth: null,
                        lastAction: null,
                        lastError: null,
                    };
                } else {
                    const e = draft.pinnedEntries[urlKey];
                    e.updatedAt = now;
                    e.lastSeenTabId = tab.id;
                    e.url = tab.url; // на всякий случай, если изменилась search
                    if (tab.title) e.titleHint = tab.title;
                }
            }
        });
    }

    async _keepTabsAlive(state, pinnedTabs) {
        const now = Date.now();

        for (const tab of pinnedTabs) {
            if (!tab?.id || !Url.isHttp(tab.url)) continue;

            // Пробуем попросить Chrome “не выгружать” (не гарантирует, но помогает). :contentReference[oaicite:2]{index=2}
            if (state.settings.preventAutoDiscardable) {
                try {
                    chrome.tabs.update(tab.id, { autoDiscardable: false }, () => {});
                } catch {
                    // игнор
                }
            }

            // Если вкладка discarded — перезагрузим (без “undiscard”: фактически reload). :contentReference[oaicite:3]{index=3}
            if (state.settings.autoRestoreDiscarded && tab.discarded) {
                await this._reloadWithCooldown(tab.id, 'discarded');
                await this._setEntryHealthByTab(tab, {
                    ok: true,
                    at: now,
                    reason: 'Вкладка была выгружена (discarded) — выполнен reload',
                });
                continue;
            }

            // Если вкладка ещё грузится — не мешаем (можно добавить таймауты позже)
            if (tab.status !== 'complete') {
                await this._setEntryHealthByTab(tab, {
                    ok: true,
                    at: now,
                    reason: `Загрузка: ${tab.status || 'unknown'}`,
                });
                continue;
            }

            // Определяем правило сайта (если есть)
            const matchedRule = RuleEngine.matchRule(tab.url, state.siteRules);
            const readinessSelector = matchedRule?.readinessSelector || 'body';
            const loginMode =
                matchedRule?.loginMode && matchedRule.loginMode !== 'off'
                    ? matchedRule.loginMode
                    : state.settings.autoLoginMode;

            const clickSelectors = Array.isArray(matchedRule?.clickSelectors)
                ? matchedRule.clickSelectors
                : [];

            // Health-check + (опционально) попытка логина
            const result = await this._execHealthAndLogin(tab.id, {
                readinessSelector,
                loginMode,
                clickSelectors,
            }).catch((err) => ({
                ok: false,
                reason: `executeScript error: ${String(err?.message || err)}`,
            }));

            if (result?.needHostPermission) {
                await this._setEntryHealthByTab(tab, {
                    ok: false,
                    at: now,
                    reason: 'Нет host-разрешения для этого сайта. Нажми “Разрешить” в popup/настройках.',
                });
                continue;
            }

            if (!result?.ok) {
                await this._setEntryHealthByTab(tab, {
                    ok: false,
                    at: now,
                    reason: result?.reason || 'Сайт не прошёл проверку готовности',
                });

                if (state.settings.aggressiveReloadOnUnhealthy) {
                    await this._reloadWithCooldown(tab.id, 'unhealthy');
                }
                continue;
            }

            // ok
            const details = [
                result?.reason ? `ready: ${result.reason}` : 'ready',
                result?.login?.attempted ? `login: ${result.login.result}` : null,
            ]
                .filter(Boolean)
                .join(' · ');

            await this._setEntryHealthByTab(tab, { ok: true, at: now, reason: details || 'OK' });
        }
    }

    async _reloadWithCooldown(tabId, why) {
        const now = Date.now();
        const last = this._reloadCooldown.get(tabId) || 0;
        // не чаще, чем раз в 30 секунд
        if (now - last < 30_000) return;
        this._reloadCooldown.set(tabId, now);

        await new Promise((resolve) => {
            chrome.tabs.reload(tabId, {}, () => resolve());
        });

        // можно логировать why в storage (через lastAction)
        await this.store.update((draft) => {
            draft._runtime = draft._runtime || {};
            draft._runtime.lastReload = { tabId, why, at: now };
        });
    }

    async _setEntryHealthByTab(tab, health) {
        const urlKey = Url.toUrlKey(tab.url);
        await this.store.update((draft) => {
            const e = draft.pinnedEntries[urlKey];
            if (!e) return;
            e.lastHealth = health;
            e.lastSeenTabId = tab.id;
            e.lastError = health.ok ? null : health.reason;
        });
    }

    async _touchPinnedFromTab(tab) {
        const now = Date.now();
        const urlKey = Url.toUrlKey(tab.url);
        await this.store.update((draft) => {
            const e = draft.pinnedEntries[urlKey];
            if (!e) return;
            e.updatedAt = now;
            e.lastSeenTabId = tab.id;
            if (tab.title) e.titleHint = tab.title;
        });
    }

    async _execHealthAndLogin(tabId, { readinessSelector, loginMode, clickSelectors }) {
        // executeScript требует host permissions, иначе будет ошибка “Cannot access contents…”
        const res = await new Promise((resolve, reject) => {
            chrome.scripting.executeScript(
                {
                    target: { tabId, allFrames: false },
                    func: async (args) => {
                        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

                        const out = {
                            ok: false,
                            reason: '',
                            login: { attempted: false, result: 'skipped' },
                        };

                        // 1) basic readiness
                        if (document.readyState !== 'complete') {
                            out.ok = true;
                            out.reason = `dom:${document.readyState}`;
                            return out;
                        }

                        const sel = (args?.readinessSelector || 'body').trim();
                        if (sel) {
                            const el = document.querySelector(sel);
                            if (!el) {
                                out.ok = false;
                                out.reason = `Нет readinessSelector: ${sel}`;
                                return out;
                            }
                        }

                        out.ok = true;
                        out.reason = `selector:${sel || 'none'}`;

                        // 2) login attempt (best-effort)
                        const mode = args?.loginMode || 'off';
                        if (mode === 'off') return out;

                        // Не ломаем UX: логин делаем очень мягко и редко
                        // (можно усложнить на уровне background, если нужно)
                        out.login.attempted = true;

                        if (mode === 'autofill') {
                            const password = document.querySelector("input[type='password']");
                            if (!password) {
                                out.login.result = 'no_password_field';
                                return out;
                            }

                            // пытаемся найти “юзернейм” поле рядом
                            const candidates = [
                                "input[type='email']",
                                "input[name*='login' i]",
                                "input[name*='user' i]",
                                "input[name*='email' i]",
                                "input[type='text']",
                            ];

                            let userField = null;
                            for (const c of candidates) {
                                const el = document.querySelector(c);
                                if (el && el !== password) {
                                    userField = el;
                                    break;
                                }
                            }

                            // фокусируем поля -> браузер может подставить автозаполнение
                            if (userField) {
                                userField.focus();
                                userField.click();
                                await sleep(150);
                            }

                            password.focus();
                            password.click();
                            await sleep(250);

                            // submit
                            const form = password.closest('form');
                            const submitBtn =
                                (form &&
                                    form.querySelector(
                                        "button[type='submit'],input[type='submit']",
                                    )) ||
                                document.querySelector(
                                    "button[type='submit'],input[type='submit']",
                                );

                            if (form?.requestSubmit) {
                                form.requestSubmit(submitBtn || undefined);
                                out.login.result = 'requestSubmit';
                                return out;
                            }

                            if (submitBtn) {
                                submitBtn.click();
                                out.login.result = 'clicked_submit';
                                return out;
                            }

                            out.login.result = 'no_submit_found';
                            return out;
                        }

                        if (mode === 'telegram') {
                            const selectors = Array.isArray(args?.clickSelectors)
                                ? args.clickSelectors
                                : [];
                            if (!selectors.length) {
                                out.login.result = 'no_selectors_configured';
                                return out;
                            }

                            let clicked = false;
                            let iframeDetected = false;

                            for (const s of selectors) {
                                const el = document.querySelector(s);
                                if (!el) continue;

                                if (el.tagName === 'IFRAME') {
                                    // клик “внутрь” iframe невозможно из-за SOP, но можем подсветить/сфокусировать
                                    iframeDetected = true;
                                    el.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
                                    el.focus?.();
                                    continue;
                                }

                                el.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
                                el.click?.();
                                clicked = true;
                                break;
                            }

                            out.login.result = clicked
                                ? 'clicked_selector'
                                : iframeDetected
                                  ? 'iframe_widget_detected_needs_user_click'
                                  : 'telegram_element_not_found';

                            return out;
                        }

                        out.login.result = 'unknown_mode';
                        return out;
                    },
                    args: [{ readinessSelector, loginMode, clickSelectors }],
                },
                (injectionResults) => {
                    const err = chrome.runtime.lastError;
                    if (err) return reject(err);
                    resolve(injectionResults?.[0]?.result);
                },
            );
        });

        return res;
    }

    // ---------------- messages ----------------

    async _onMessage(msg) {
        const state = await this.store.getState();

        switch (msg?.type) {
            case MSG.GET_STATUS: {
                const tabs = await new Promise((resolve) => chrome.tabs.query({}, resolve));

                const trackedTabs = tabs.filter((t) => {
                    if (!Url.isHttp(t.url)) return false;

                    if (t.pinned) return true;

                    const urlKey = Url.toUrlKey(t.url);
                    const entry = state.pinnedEntries[urlKey];
                    return entry && entry.enabled;
                });

                return {
                    ok: true,
                    status: {
                        enabled: state.settings.enabled,
                        lastCycleAt: state._runtime?.lastCycleAt || null,
                        lastCycleReason: state._runtime?.lastCycleReason || null,
                        pinnedTabsNow: trackedTabs.length,
                    },
                    pinnedEntries: state.pinnedEntries,
                    settings: state.settings,
                    siteRules: state.siteRules,
                };
            }

            case MSG.GET_STATE:
                return { ok: true, state };

            case MSG.UPDATE_SETTINGS: {
                const patch = msg?.patch || {};
                const next = await this.store.update((draft) => {
                    draft.settings = { ...draft.settings, ...patch };
                });
                await this._ensureAlarm();
                return { ok: true, settings: next.settings };
            }

            case MSG.SCAN_NOW:
                await this.runCycle('scan_now');
                return { ok: true };

            case MSG.PIN_CURRENT: {
                const tab = await this._getActiveTab();
                if (!tab?.id || !Url.isHttp(tab.url))
                    return { ok: false, error: 'Активная вкладка не http(s)' };

                const now = Date.now();
                const urlKey = Url.toUrlKey(tab.url);

                await this.store.update((draft) => {
                    const existing = draft.pinnedEntries[urlKey];
                    draft.pinnedEntries[urlKey] = existing || {
                        id: Id.uuid(),
                        urlKey,
                        url: tab.url,
                        titleHint: tab.title || Url.hostname(tab.url) || 'Отслеживаемая вкладка',
                        enabled: true,
                        createdAt: now,
                        updatedAt: now,
                        lastSeenTabId: tab.id,
                        lastHealth: null,
                        lastAction: null,
                        lastError: null,
                    };

                    const e = draft.pinnedEntries[urlKey];
                    e.updatedAt = now;
                    e.lastSeenTabId = tab.id;
                    e.enabled = true;
                    if (tab.title) e.titleHint = tab.title;
                });

                await this.runCycle('pin_current');
                return { ok: true };
            }

            case MSG.CLEAR_PINNED_DB: {
                await this.store.update((draft) => {
                    draft.pinnedEntries = {};
                });
                return { ok: true };
            }

            case MSG.EXPORT_STATE:
                return { ok: true, state };

            case MSG.IMPORT_STATE: {
                const importState = msg?.state;
                if (!importState || typeof importState !== 'object')
                    return { ok: false, error: 'Неверный формат' };

                const next = await this.store.update((draft) => {
                    if (importState.settings)
                        draft.settings = { ...draft.settings, ...importState.settings };
                    if (Array.isArray(importState.siteRules))
                        draft.siteRules = importState.siteRules;
                    if (
                        importState.pinnedEntries &&
                        typeof importState.pinnedEntries === 'object'
                    ) {
                        draft.pinnedEntries = importState.pinnedEntries;
                    }
                });

                await this._ensureAlarm();
                return { ok: true, state: next };
            }

            case MSG.OPEN_TAB: {
                const tabId = Number(msg?.tabId);
                if (!tabId) return { ok: false };
                await new Promise((resolve) =>
                    chrome.tabs.update(tabId, { active: true }, () => resolve()),
                );
                return { ok: true };
            }

            case MSG.RELOAD_TAB: {
                const tabId = Number(msg?.tabId);
                if (!tabId) return { ok: false };
                await this._reloadWithCooldown(tabId, 'manual');
                return { ok: true };
            }

            case MSG.REQUEST_HOST_PERMISSION: {
                const origin = msg?.origin;
                if (!origin) return { ok: false, error: 'Нет origin' };

                const pattern = Url.originToPermissionPattern(origin);
                const granted = await new Promise((resolve) => {
                    chrome.permissions.request({ origins: [pattern] }, (ok) =>
                        resolve(Boolean(ok)),
                    );
                });

                return { ok: true, granted, pattern };
            }

            case MSG.GET_HOST_PERMISSIONS: {
                const perms = await new Promise((resolve) => chrome.permissions.getAll(resolve));
                return { ok: true, perms };
            }

            case MSG.OPEN_OPTIONS:
                chrome.runtime.openOptionsPage();
                return { ok: true };

            default:
                return { ok: false, error: 'Unknown message' };
        }
    }

    async _getActiveTab() {
        const tabs = await new Promise((resolve) =>
            chrome.tabs.query({ active: true, lastFocusedWindow: true }, resolve),
        );
        return tabs?.[0];
    }
}

const service = new KeepAliveService();
service.init().catch(logFatal);
