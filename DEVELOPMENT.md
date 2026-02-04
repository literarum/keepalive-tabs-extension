# KeepAlive Tabs Extension - Development Guide

## 🚀 Быстрый старт

### Установка зависимостей

```bash
npm install
```

### Разработка

```bash
# Сборка CSS один раз
npm run build

# Или режим watch (автоматическая сборка при изменениях)
npm run dev
```

### Загрузка в Chrome

1. Откройте `chrome://extensions/`
2. Включите "Режим разработчика" (переключатель в правом углу)
3. Нажмите "Загрузить распакованное расширение"
4. Выберите папку проекта

## 📖 Архитектура

### Service Worker (`src/background/service_worker.js`)

- Основная логика расширения
- Управление вкладками и alarm'ами
- Отправка сообщений к content scripts
- Хранение состояния в Chrome Storage

**Ключевые классы:**

- `KeepAliveService` — главный класс со всей логикой

### Content Scripts

- `src/content/healthcheck.js` — проверка состояния страницы
- `src/content/autologin.js` — автоматический вход

### Options Page (`src/options/`)

- Управление настройками
- Редактирование правил сайтов
- Управление разрешениями

### Popup (`src/popup/`)

- Быстрый доступ к статусу
- Запуск проверки вкладок

### Common Modules (`src/common/`)

- `storage.js` — работа с Chrome Storage
- `defaults.js` — стандартные настройки
- `messages.js` — типы сообщений
- `rules.js` — логика правил
- `tabsRegistry.js` — реестр вкладок

## 🔄 Поток данных

```
Service Worker (background)
    ↓
    ├─→ Chrome Storage (состояние)
    ├─→ Content Scripts (healthcheck, autologin)
    └─→ Options/Popup UI
```

## 📝 Добавление новой опции

1. Добавьте в `src/common/defaults.js`:

```javascript
settings: {
    myNewOption: true,
    // ... остальное
}
```

2. Добавьте в `src/options/options.html`:

```html
<input id="opt_myNewOption" type="checkbox" />
```

3. Добавьте в `src/options/options.js`:

```javascript
this.el.myNewOption = document.getElementById('opt_myNewOption');
// ... в _wire()
// ... в _load()
// ... в _save()
```

## 🎨 CSS и Tailwind

Проект использует **Tailwind CSS v4** с `@layer components` для кастомных стилей.

### Сборка

```bash
npm run build
# Генерирует src/output.css
```

### Добавление новых стилей

Изменяйте `src_styles/input.css`:

```css
@layer components {
    .my-class {
        /* стили */
    }
}
```

## 🐛 Отладка

### Консоль Service Worker

1. `chrome://extensions/`
2. Найдите расширение "KeepAlive Tabs"
3. Нажмите "service worker" в секции Details

### Консоль Content Script

1. Откройте DevTools на любой странице (F12)
2. Смотрите console.log из content scripts

### Сообщения между скриптами

Все сообщения идут через `chrome.runtime.sendMessage()` и `chrome.runtime.onMessage`.

Типы сообщений определены в `src/common/messages.js`:

```javascript
export const MSG = {
    UPDATE_SETTINGS: 'update_settings',
    GET_HOST_PERMISSIONS: 'get_host_permissions',
    // ...
};
```

## 📦 Структура манифеста

`manifest.json` определяет:

- Permissions (tabs, storage, alarms, scripting, activeTab)
- Host permissions (http://_, https://_)
- Service Worker (src/background/service_worker.js)
- Options page (src/options/options.html)
- Popup (src/popup/index.html)
- Icons (для разных размеров)

## ✅ Тестирование

1. Загрузьте расширение в режиме разработки
2. Откройте несколько вкладок и закрепите их
3. Откройте Options страницу расширения
4. Проверьте:
    - Слайдеры двигаются
    - Настройки сохраняются
    - Health-check периодически запускается
    - Вкладки восстанавливаются при выгрузке

## 🚢 Подготовка к релизу

1. Обновите версию в `manifest.json` и `package.json`
2. Убедитесь что CSS собран: `npm run build`
3. Убедитесь что все тестовые файлы удалены
4. Создайте ZIP архив папки проекта
5. Загрузите в Chrome Web Store (см. [PUBLISHING.md](../PUBLISHING.md))

## 📚 Полезные ссылки

- [Chrome Extensions API](https://developer.chrome.com/docs/extensions/)
- [Manifest V3](https://developer.chrome.com/docs/extensions/mv3/)
- [Tailwind CSS](https://tailwindcss.com/)
- [Chrome Web Store Submission](https://developer.chrome.com/docs/webstore/publish/)

## 🤝 Контрибьютинг

1. Форкните репозиторий
2. Создайте ветку для вашей фичи (`git checkout -b feature/AmazingFeature`)
3. Коммитьте изменения (`git commit -m 'Add some AmazingFeature'`)
4. Пушьте в ветку (`git push origin feature/AmazingFeature`)
5. Откройте Pull Request

---

**Последнее обновление:** 4 февраля 2026 г.
