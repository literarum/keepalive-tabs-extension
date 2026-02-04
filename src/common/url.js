export class Url {
    /** @param {string} url */
    static isHttp(url) {
        return typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'));
    }

    /** @param {string} url */
    static toUrlKey(url) {
        try {
            const u = new globalThis.URL(url);
            // hash не влияет на “сервисность”, но часто меняется
            return `${u.origin}${u.pathname}${u.search}`;
        } catch {
            return url;
        }
    }

    /** @param {string} url */
    static hostname(url) {
        try {
            return new globalThis.URL(url).hostname;
        } catch {
            return '';
        }
    }

    /** @param {string} urlKey */
    static originFromUrlKey(urlKey) {
        try {
            const u = new globalThis.URL(urlKey);
            return u.origin;
        } catch {
            return '';
        }
    }

    /** @param {string} origin */
    static originToPermissionPattern(origin) {
        // "https://example.com" -> "https://example.com/*"
        try {
            const u = new globalThis.URL(origin);
            return `${u.origin}/*`;
        } catch {
            return origin;
        }
    }
}
