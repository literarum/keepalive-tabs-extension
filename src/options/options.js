import { StateStore } from '../common/storage.js';
import { DEFAULT_STATE } from '../common/defaults.js';
import { Id } from '../common/ids.js';
import { Url } from '../common/url.js';
import { MSG } from '../common/messages.js';

class OptionsApp {
    constructor() {
        this.store = new StateStore('local');

        this.el = {
            saveBtn: document.getElementById('saveBtn'),
            resetBtn: document.getElementById('resetBtn'),

            enabled: document.getElementById('opt_enabled'),
            keepPinnedAlive: document.getElementById('opt_keepPinnedAlive'),
            autoRestoreDiscarded: document.getElementById('opt_autoRestoreDiscarded'),
            preventAutoDiscardable: document.getElementById('opt_preventAutoDiscardable'),
            healthIntervalSec: document.getElementById('opt_healthIntervalSec'),
            healthIntervalSecDisplay: document.getElementById('opt_healthIntervalSec_display'),
            autoLoginMode: document.getElementById('opt_autoLoginMode'),

            addRuleBtn: document.getElementById('addRuleBtn'),
            rulesList: document.getElementById('rulesList'),

            refreshPermsBtn: document.getElementById('refreshPermsBtn'),
            permsBox: document.getElementById('permsBox'),
        };

        this.state = null;
    }

    async init() {
        this._wire();
        await this._load();
        await this._refreshPerms();
    }

    _wire() {
        this.el.saveBtn.addEventListener('click', () => this._save());
        this.el.resetBtn.addEventListener('click', async () => {
            if (!confirm('Сбросить настройки к умолчанию?')) return;
            await this.store.update(() => structuredClone(DEFAULT_STATE));
            await this._load();
            await this._refreshPerms();
            alert('Сброшено');
        });

        // Обновляем дисплей значения при движении слайдера
        this.el.healthIntervalSec.addEventListener('input', (e) => {
            const value = e.target.value;
            this.el.healthIntervalSecDisplay.textContent = value;
            console.log('[KeepAlive] Slider moved to:', value);
        });

        this.el.healthIntervalSec.addEventListener('change', (e) => {
            console.log('[KeepAlive] Slider changed to:', e.target.value);
        });

        this.el.addRuleBtn.addEventListener('click', () => {
            this.state.siteRules.push({
                id: Id.uuid(),
                enabled: true,
                name: 'Новое правило',
                match: 'https://example.com/*',
                readinessSelector: 'body',
                loginMode: 'off',
                clickSelectors: [],
            });
            this._renderRules();
        });

        this.el.refreshPermsBtn.addEventListener('click', () => this._refreshPerms());

        // делегирование для правил
        this.el.rulesList.addEventListener('click', async (e) => {
            const btn = e.target.closest('button[data-action]');
            if (!btn) return;
            const action = btn.dataset.action;
            const id = btn.dataset.id;

            if (action === 'remove') {
                this.state.siteRules = this.state.siteRules.filter((r) => r.id !== id);
                this._renderRules();
            }

            if (action === 'request') {
                const rule = this.state.siteRules.find((r) => r.id === id);
                if (!rule?.match) return alert('У правила нет match');

                // Берём origin из match (если можно)
                const origin = this._originFromMatch(rule.match);
                if (!origin)
                    return alert('Не удалось извлечь origin. Используй формат: https://domain/*');

                const pattern = Url.originToPermissionPattern(origin);
                const granted = await new Promise((resolve) => {
                    chrome.permissions.request({ origins: [pattern] }, (ok) =>
                        resolve(Boolean(ok)),
                    );
                });

                alert(granted ? 'Разрешение выдано' : 'Разрешение не выдано');
                await this._refreshPerms();
            }
        });

        // делегирование для input
        this.el.rulesList.addEventListener('input', (e) => {
            const row = e.target.closest('[data-rule-id]');
            if (!row) return;
            const id = row.dataset.ruleId;
            const rule = this.state.siteRules.find((r) => r.id === id);
            if (!rule) return;

            const enabled = row.querySelector("input[name='enabled']");
            const name = row.querySelector("input[name='name']");
            const match = row.querySelector("input[name='match']");
            const readinessSelector = row.querySelector("input[name='readinessSelector']");
            const loginMode = row.querySelector("select[name='loginMode']");
            const clickSelectors = row.querySelector("textarea[name='clickSelectors']");

            rule.enabled = Boolean(enabled.checked);
            rule.name = name.value;
            rule.match = match.value;
            rule.readinessSelector = readinessSelector.value || 'body';
            rule.loginMode = loginMode.value;
            rule.clickSelectors = (clickSelectors.value || '')
                .split('\n')
                .map((s) => s.trim())
                .filter(Boolean);
        });
    }

    async _load() {
        this.state = await this.store.getState();

        const s = this.state.settings;
        this.el.enabled.checked = Boolean(s.enabled);
        this.el.keepPinnedAlive.checked = Boolean(s.keepPinnedAlive);
        this.el.autoRestoreDiscarded.checked = Boolean(s.autoRestoreDiscarded);
        this.el.preventAutoDiscardable.checked = Boolean(s.preventAutoDiscardable);

        const healthValue = Math.max(60, Number(s.healthIntervalSec || 60));
        this.el.healthIntervalSec.value = String(healthValue);
        this.el.healthIntervalSecDisplay.textContent = String(healthValue);

        this.el.autoLoginMode.value = s.autoLoginMode || 'off';

        this._renderRules();
    }

    async _save() {
        const patch = {
            enabled: this.el.enabled.checked,
            keepPinnedAlive: this.el.keepPinnedAlive.checked,
            autoRestoreDiscarded: this.el.autoRestoreDiscarded.checked,
            preventAutoDiscardable: this.el.preventAutoDiscardable.checked,
            healthIntervalSec: Math.max(60, Number(this.el.healthIntervalSec.value || 60)),
            autoLoginMode: this.el.autoLoginMode.value,
        };

        await this.store.update((draft) => {
            draft.settings = { ...draft.settings, ...patch };
            draft.siteRules = this.state.siteRules;
        });

        // обновим alarms/настройки background
        await new Promise((resolve) => {
            chrome.runtime.sendMessage({ type: MSG.UPDATE_SETTINGS, patch }, () => resolve());
        });

        alert('Сохранено');
    }

    _renderRules() {
        const rules = this.state.siteRules || [];
        this.el.rulesList.innerHTML = rules
            .map((r) => {
                return `
          <div data-rule-id="${this._escAttr(r.id)}" class="rounded-3xl bg-slate-950/40 p-4 ring-1 ring-slate-800/60">
            <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div class="flex items-center gap-3">
                <input name="enabled" type="checkbox" class="h-5 w-5 accent-indigo-500" ${r.enabled ? 'checked' : ''} />
                <div class="min-w-0">
                  <div class="text-sm font-semibold">Правило</div>
                  <div class="text-xs text-slate-400">id: ${this._esc(r.id)}</div>
                </div>
              </div>

              <div class="flex flex-wrap gap-2">
                <button
                  data-action="request"
                  data-id="${this._escAttr(r.id)}"
                  class="rounded-2xl bg-slate-900 px-3 py-2 text-xs font-semibold text-slate-200 ring-1 ring-slate-800 hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  Разрешить host
                </button>
                <button
                  data-action="remove"
                  data-id="${this._escAttr(r.id)}"
                  class="rounded-2xl bg-slate-900 px-3 py-2 text-xs font-semibold text-rose-200 ring-1 ring-slate-800 hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-rose-400"
                >
                  Удалить
                </button>
              </div>
            </div>

            <div class="mt-4 grid gap-3 sm:grid-cols-2">
              <label class="block">
                <span class="text-xs text-slate-400">Название</span>
                <input
                  name="name"
                  class="mt-1 h-10 w-full rounded-xl bg-slate-900 px-3 text-sm text-slate-100 ring-1 ring-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  value="${this._escAttr(r.name || '')}"
                />
              </label>

              <label class="block">
                <span class="text-xs text-slate-400">Match (wildcard)</span>
                <input
                  name="match"
                  class="mt-1 h-10 w-full rounded-xl bg-slate-900 px-3 text-sm text-slate-100 ring-1 ring-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  value="${this._escAttr(r.match || '')}"
                  placeholder="https://example.com/*"
                />
              </label>

              <label class="block">
                <span class="text-xs text-slate-400">Readiness selector</span>
                <input
                  name="readinessSelector"
                  class="mt-1 h-10 w-full rounded-xl bg-slate-900 px-3 text-sm text-slate-100 ring-1 ring-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  value="${this._escAttr(r.readinessSelector || 'body')}"
                  placeholder="body или #app"
                />
              </label>

              <label class="block">
                <span class="text-xs text-slate-400">Login mode</span>
                <select
                  name="loginMode"
                  class="mt-1 h-10 w-full rounded-xl bg-slate-900 px-3 text-sm text-slate-100 ring-1 ring-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  ${['off', 'autofill', 'telegram']
                      .map(
                          (v) =>
                              `<option value="${v}" ${r.loginMode === v ? 'selected' : ''}>${v}</option>`,
                      )
                      .join('')}
                </select>
              </label>

              <label class="block sm:col-span-2">
                <span class="text-xs text-slate-400">Click selectors (для telegram), по одному в строке</span>
                <textarea
                  name="clickSelectors"
                  class="mt-1 min-h-[96px] w-full rounded-xl bg-slate-900 px-3 py-2 text-sm text-slate-100 ring-1 ring-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  placeholder="[data-telegram-login]\nbutton[class*='telegram']"
                >${this._esc((r.clickSelectors || []).join('\n'))}</textarea>
              </label>
            </div>
          </div>
        `;
            })
            .join('');
    }

    async _refreshPerms() {
        const res = await new Promise((resolve) => {
            chrome.runtime.sendMessage({ type: MSG.GET_HOST_PERMISSIONS }, (resp) => resolve(resp));
        });
        const perms = res?.perms || {};
        this.el.permsBox.textContent = JSON.stringify(perms, null, 2);
    }

    _originFromMatch(match) {
        // ожидаем формат вроде "https://domain/*"
        try {
            const cleaned = match.replace('*', '');
            const u = new URL(cleaned);
            return u.origin;
        } catch {
            return null;
        }
    }

    _esc(s) {
        return String(s ?? '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#039;');
    }

    _escAttr(s) {
        return this._esc(s).replaceAll('`', '&#096;');
    }
}

function logFatal(err) {
    console.error('[KeepAliveTabs] options fatal:', err);
}
globalThis.addEventListener?.('unhandledrejection', (e) => logFatal(e?.reason));
globalThis.addEventListener?.('error', (e) => logFatal(e?.error || e?.message));
new OptionsApp().init().catch(logFatal);
