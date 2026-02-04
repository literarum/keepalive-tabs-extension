import { MSG } from '../common/messages.js';
import { Url } from '../common/url.js';

class PopupApp {
    constructor() {
        this.el = {
            openOptionsBtn: document.getElementById('openOptionsBtn'),
            openOptionsSecondaryBtn: document.getElementById('openOptionsSecondaryBtn'),
            helpBtn: document.getElementById('helpBtn'),

            statusDot: document.getElementById('statusDot'),
            statusLabel: document.getElementById('statusLabel'),

            masterEnabled: document.getElementById('masterEnabled'),
            keepPinnedAlive: document.getElementById('keepPinnedAlive'),
            autoRestoreDiscarded: document.getElementById('autoRestoreDiscarded'),
            autoLoginMode: document.getElementById('autoLoginMode'),

            scanNowBtn: document.getElementById('scanNowBtn'),
            pinCurrentBtn: document.getElementById('pinCurrentBtn'),

            pinnedCount: document.getElementById('pinnedCount'),
            emptyState: document.getElementById('emptyState'),
            pinnedList: document.getElementById('pinnedList'),

            exportBtn: document.getElementById('exportBtn'),
            importBtn: document.getElementById('importBtn'),
            clearBtn: document.getElementById('clearBtn'),
        };

        this.state = null;
    }

    async init() {
        this._wireUi();
        await this.refresh();
    }

    _wireUi() {
        // Инициализация кастомного dropdown для autoLoginMode
        this._initCustomAutoLoginModeSelect();
        const openOptions = () => {
            // Не завязываем кнопку на работоспособность service worker:
            // popup сам умеет открывать options page.
            try {
                chrome.runtime.openOptionsPage();
            } catch {
                // fallback (на случай нестандартной среды)
                this._send(MSG.OPEN_OPTIONS);
            }
        };

        this.el.openOptionsBtn?.addEventListener('click', openOptions);
        this.el.openOptionsSecondaryBtn?.addEventListener('click', openOptions);

        this.el.helpBtn?.addEventListener('click', () => {
            this._toast(
                'Подсказка: Чтобы health-check работал в фоне, открой “Настройки” и выдай host-разрешения нужным сайтам.',
            );
        });

        this.el.scanNowBtn?.addEventListener('click', async () => {
            await this._send(MSG.SCAN_NOW);
            await this.refresh();
            this._toast('Проверка запущена');
        });

        this.el.pinCurrentBtn?.addEventListener('click', async () => {
            const res = await this._send(MSG.PIN_CURRENT);
            if (!res?.ok) this._toast(res?.error || 'Не удалось закрепить');
            await this.refresh();
        });

        // settings changes
        this.el.masterEnabled?.addEventListener('change', () =>
            this._patchSettings({ enabled: this.el.masterEnabled.checked }),
        );
        this.el.keepPinnedAlive?.addEventListener('change', () =>
            this._patchSettings({ keepPinnedAlive: this.el.keepPinnedAlive.checked }),
        );
        this.el.autoRestoreDiscarded?.addEventListener('change', () =>
            this._patchSettings({ autoRestoreDiscarded: this.el.autoRestoreDiscarded.checked }),
        );

        this.el.autoLoginMode?.addEventListener('change', () => {
            this._patchSettings({ autoLoginMode: this.el.autoLoginMode.value });
        });

        this.el.exportBtn?.addEventListener('click', async () => {
            const res = await this._send(MSG.EXPORT_STATE);
            if (!res?.ok) return this._toast('Экспорт не удался');
            const text = JSON.stringify(res.state, null, 2);
            await navigator.clipboard.writeText(text).catch(() => {});
            this._toast('Экспорт скопирован в буфер обмена');
        });

        this.el.importBtn?.addEventListener('click', async () => {
            // Мини-импорт через prompt (для новичка проще)
            const text = prompt('Вставь JSON состояния (export):');
            if (!text) return;
            try {
                const obj = JSON.parse(text);
                const res = await this._send(MSG.IMPORT_STATE, { state: obj });
                if (!res?.ok) return this._toast(res?.error || 'Импорт не удался');
                this._toast('Импорт выполнен');
                await this.refresh();
            } catch {
                this._toast('Не удалось разобрать JSON');
            }
        });

        this.el.clearBtn?.addEventListener('click', async () => {
            if (!confirm('Очистить базу закреплённых вкладок?')) return;
            await this._send(MSG.CLEAR_PINNED_DB);
            await this.refresh();
            this._toast('Очищено');
        });

        // делегирование действий списка
        this.el.pinnedList?.addEventListener('click', async (e) => {
            const btn = e.target.closest('button[data-action]');
            if (!btn) return;

            const action = btn.dataset.action;
            const tabId = btn.dataset.tabId ? Number(btn.dataset.tabId) : null;
            const origin = btn.dataset.origin || null;

            if (action === 'open' && tabId) await this._send(MSG.OPEN_TAB, { tabId });
            if (action === 'reload' && tabId) {
                await this._send(MSG.RELOAD_TAB, { tabId });
                await this.refresh();
            }
            if (action === 'grant' && origin) {
                const res = await this._send(MSG.REQUEST_HOST_PERMISSION, { origin });
                this._toast(res?.granted ? 'Разрешение выдано' : 'Разрешение не выдано');
                await this.refresh();
            }
        });
    }

    _initCustomAutoLoginModeSelect() {
        const btn = document.getElementById('autoLoginModeBtn');
        const menu = document.getElementById('autoLoginModeMenu');
        const label = document.getElementById('autoLoginModeLabel');
        const options = document.querySelectorAll('.auto-login-option');
        const hiddenSelect = this.el.autoLoginMode;

        if (!btn || !menu || !label) return;

        const labelMap = {
            off: 'Выкл',
            autofill: 'Попытка автозаполнения',
            telegram: 'Клик Telegram Login',
        };

        const toggleMenu = (show) => {
            if (show) {
                menu.classList.remove('opacity-0', 'invisible', 'pointer-events-none');
                menu.style.transform = 'scale(1) translateY(0)';
                btn.classList.add('ring-2', 'ring-indigo-500');
            } else {
                menu.classList.add('opacity-0', 'invisible', 'pointer-events-none');
                menu.style.transform = 'scale(0.95) translateY(-4px)';
                btn.classList.remove('ring-2', 'ring-indigo-500');
            }
        };

        const updateSelection = (value) => {
            hiddenSelect.value = value;
            label.textContent = labelMap[value] || value;

            // Обновляем визуальное состояние (точка рядом с выбранным)
            options.forEach((opt) => {
                const indicator = opt.querySelector('span:first-child');
                if (opt.dataset.value === value) {
                    indicator?.classList.remove('opacity-0');
                } else {
                    indicator?.classList.add('opacity-0');
                }
            });

            // Закрываем меню
            toggleMenu(false);

            // Отправляем событие change для совместимости
            hiddenSelect.dispatchEvent(new Event('change', { bubbles: true }));
        };

        // Клик по кнопке открывает/закрывает меню
        btn.addEventListener('click', () => {
            const isOpen = !menu.classList.contains('opacity-0');
            toggleMenu(!isOpen);
        });

        // Обработка клика по опциям
        options.forEach((opt) => {
            opt.addEventListener('click', () => {
                const value = opt.dataset.value;
                updateSelection(value);
            });
        });

        // Закрытие меню при клике вне
        document.addEventListener('click', (e) => {
            if (!btn.contains(e.target) && !menu.contains(e.target)) {
                toggleMenu(false);
            }
        });

        // Клавиша Escape закрывает меню
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !menu.classList.contains('opacity-0')) {
                toggleMenu(false);
            }
        });

        // Убеждаемся что меню закрыто по умолчанию
        toggleMenu(false);
    }

    async _patchSettings(patch) {
        const res = await this._send(MSG.UPDATE_SETTINGS, { patch });
        if (!res?.ok) this._toast(res?.error || 'Не удалось применить настройки');
        await this.refresh();
    }

    async refresh() {
        const res = await this._send(MSG.GET_STATUS);
        if (!res?.ok) {
            this.state = null;
            this.el.statusDot.className = 'block h-3 w-3 rounded-full bg-rose-500';
            this.el.statusLabel.textContent = res?.error
                ? `Ошибка: ${res.error}`
                : 'Нет связи с background';
            return;
        }

        this.state = res;
        this._renderStatus(res.status, res.settings);
        this._renderSettings(res.settings);
        this._renderPinnedEntries(res.pinnedEntries);
    }

    _renderOffline(error) {
        if (this.el.statusDot)
            this.el.statusDot.className = 'block h-3 w-3 rounded-full bg-slate-500';
        if (this.el.statusLabel)
            this.el.statusLabel.textContent = error ? `SW: ${error}` : 'Service worker недоступен';
    }

    _renderStatus(status, settings) {
        const enabled = Boolean(settings?.enabled);
        const dot = this.el.statusDot;
        const label = this.el.statusLabel;

        if (!enabled) {
            dot.className = 'block h-3 w-3 rounded-full bg-slate-500';
            label.textContent = 'Выключено';
            return;
        }

        dot.className = 'block h-3 w-3 rounded-full bg-emerald-500';
        label.textContent = 'Активно';
    }

    _renderSettings(settings) {
        this.el.masterEnabled.checked = Boolean(settings.enabled);
        this.el.keepPinnedAlive.checked = Boolean(settings.keepPinnedAlive);
        this.el.autoRestoreDiscarded.checked = Boolean(settings.autoRestoreDiscarded);

        const autoLoginValue = settings.autoLoginMode || 'off';
        this.el.autoLoginMode.value = autoLoginValue;

        // Обновляем кастомный dropdown
        const label = document.getElementById('autoLoginModeLabel');
        if (label) {
            const labelMap = {
                off: 'Выкл',
                autofill: 'Попытка автозаполнения',
                telegram: 'Клик Telegram Login',
            };
            label.textContent = labelMap[autoLoginValue] || autoLoginValue;

            // Обновляем визуальные индикаторы выбранного элемента
            const options = document.querySelectorAll('.auto-login-option');
            options.forEach((opt) => {
                const indicator = opt.querySelector('span:first-child');
                if (opt.dataset.value === autoLoginValue) {
                    indicator?.classList.remove('opacity-0');
                } else {
                    indicator?.classList.add('opacity-0');
                }
            });
        }
    }

    _renderPinnedEntries(pinnedEntries) {
        const entries = Object.values(pinnedEntries || {}).sort(
            (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0),
        );

        this.el.pinnedCount.textContent = String(entries.length);

        if (!entries.length) {
            this.el.emptyState.classList.remove('hidden');
            this.el.pinnedList.classList.add('hidden');
            this.el.pinnedList.innerHTML = '';
            return;
        }

        this.el.emptyState.classList.add('hidden');
        this.el.pinnedList.classList.remove('hidden');

        this.el.pinnedList.innerHTML = entries
            .map((e) => {
                const ok = e?.lastHealth?.ok;
                const badgeBg = ok ? 'bg-emerald-500/20' : 'bg-rose-500/20';
                const badgeText = ok ? 'text-emerald-300' : 'text-rose-300';
                const badgeBorder = ok ? 'border-emerald-500/40' : 'border-rose-500/40';
                const statusDotColor = ok ? 'bg-emerald-500' : 'bg-rose-500';

                const statusText = e?.lastHealth?.reason || (ok ? 'OK' : 'Нет данных');
                const tabId = e?.lastSeenTabId || '';
                const origin = Url.originFromUrlKey(e.urlKey) || '';

                // если ok=false по причине host-permission — показываем кнопку “Разрешить”
                const needsPerm =
                    !ok &&
                    typeof statusText === 'string' &&
                    statusText.toLowerCase().includes('host-разреш');

                return `
          <li class="group relative overflow-hidden rounded-2xl bg-slate-950/40 ring-1 ring-slate-800/60 transition-all hover:shadow-lg hover:shadow-slate-900/50">
            <!-- Left accent bar -->
            <div class="absolute left-0 top-0 bottom-0 w-1 ${statusDotColor} opacity-0 group-hover:opacity-100 transition-opacity duration-200"></div>

            <div class="flex items-start gap-3 px-4 py-3">
              <!-- Favicon / Icon -->
              <div class="mt-0.5 relative">
                <div class="grid h-10 w-10 place-items-center rounded-xl bg-slate-800/60">
                  <span class="text-xs font-bold text-slate-200">${(Url.hostname(e.url) || 'TAB').slice(0, 2).toUpperCase()}</span>
                </div>
                <div class="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border border-slate-950 ${statusDotColor}"></div>
              </div>

              <!-- Main content -->
              <div class="min-w-0 flex-1">
                <div class="truncate text-sm font-semibold text-slate-50">${this._escape(e.titleHint || 'Закреплённая')}</div>
                <div class="truncate text-xs text-slate-500 mt-0.5">${this._escape(e.url)}</div>

                <!-- Status badge and reason -->
                <div class="mt-3 flex flex-wrap items-center gap-2">
                  <span class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${badgeBg} ${badgeText} border ${badgeBorder}">
                    <span class="h-1.5 w-1.5 rounded-full ${statusDotColor}"></span>
                    <span class="${ok ? 'bg-emerald-500/30 rounded-lg px-2 py-1 text-emerald-300' : 'text-rose-400'}">${ok ? 'OK' : 'ОШИБКА'}</span>
                  </span>
                  <span class="text-xs text-slate-400">
                    ${this._escape(statusText)}
                  </span>
                </div>

                ${
                    needsPerm && origin
                        ? `<button
                          data-action="grant"
                          data-origin="${this._escapeAttr(origin)}"
                          class="mt-3 inline-flex gap-2 items-center rounded-lg bg-amber-600/20 border border-amber-500/30 hover:border-amber-500/50 hover:bg-amber-600/30 px-3 py-2 text-xs font-medium text-amber-300 transition-colors focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="h-3.5 w-3.5">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
                          </svg>
                          Выдать разрешение
                        </button>`
                        : ''
                }
              </div>

              <!-- Action buttons -->
              <div class="flex shrink-0 flex-col gap-2">
                <button
                  data-action="open"
                  data-tab-id="${this._escapeAttr(String(tabId))}"
                  class="group grid h-8 w-8 place-items-center rounded-lg bg-slate-800/50 text-slate-400 border border-slate-700/50 transition-all hover:bg-indigo-600/80 hover:text-white hover:border-indigo-500/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                  ${tabId ? '' : 'disabled'}
                  title="Открыть вкладку"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="h-4 w-4">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                  </svg>
                </button>

                <button
                  data-action="reload"
                  data-tab-id="${this._escapeAttr(String(tabId))}"
                  class="group grid h-8 w-8 place-items-center rounded-lg bg-slate-800/50 text-slate-400 border border-slate-700/50 transition-all hover:bg-emerald-600/80 hover:text-white hover:border-emerald-500/60 focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
                  ${tabId ? '' : 'disabled'}
                  title="Перезагрузить"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="h-4 w-4">
                     <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
                  </svg>
                </button>
              </div>
            </div>
          </li>
        `;
            })
            .join('');
    }

    async _send(type, payload = {}) {
        return new Promise((resolve) => {
            const msg = { type };
            if (payload && typeof payload === 'object') Object.assign(msg, payload);

            chrome.runtime.sendMessage(msg, (resp) => {
                const err = chrome.runtime.lastError;
                if (err) return resolve({ ok: false, error: err.message });
                resolve(resp);
            });
        });
    }

    _toast(text) {
        // простейший тост без изменения HTML
        const div = document.createElement('div');
        div.className =
            'fixed bottom-3 left-1/2 z-50 -translate-x-1/2 rounded-2xl bg-slate-900/95 px-4 py-2 text-xs text-slate-100 ring-1 ring-slate-700 shadow-lg';
        div.textContent = text;
        document.body.appendChild(div);
        setTimeout(() => div.remove(), 2200);
    }

    _escape(s) {
        return String(s ?? '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#039;');
    }

    _escapeAttr(s) {
        return this._escape(s).replaceAll('`', '&#096;');
    }
}

function renderFatal(err) {
    const msg = String(err?.message || err || 'Unknown error');
    const label = document.getElementById('statusLabel');
    const dot = document.getElementById('statusDot');
    const sr = document.getElementById('statusText');
    if (dot) dot.className = 'block h-3 w-3 rounded-full bg-rose-400';
    if (sr) sr.textContent = `Статус: ошибка (${msg})`;
    if (label) label.textContent = `Ошибка инициализации: ${msg}`;
    console.error('[KeepAliveTabs] popup fatal:', err);
}

globalThis.addEventListener?.('unhandledrejection', (e) => renderFatal(e?.reason));
globalThis.addEventListener?.('error', (e) => renderFatal(e?.error || e?.message));

const app = new PopupApp();
app.init().catch(renderFatal);
