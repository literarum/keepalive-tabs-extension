export class RuleEngine {
    /**
     * Простой wildcard matcher: "*" -> ".*"
     * @param {string} pattern
     * @returns {RegExp}
     */
    static wildcardToRegExp(pattern) {
        const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
        return new RegExp(`^${escaped}$`, 'i');
    }

    /**
     * @param {string} url
     * @param {Array<{id:string,enabled:boolean,match:string}>} rules
     */
    static matchRule(url, rules) {
        if (!url || !Array.isArray(rules)) return null;
        for (const r of rules) {
            if (!r?.enabled || !r?.match) continue;
            try {
                const re = RuleEngine.wildcardToRegExp(r.match);
                if (re.test(url)) return r;
            } catch {
                // игнор плохих regex
            }
        }
        return null;
    }
}
