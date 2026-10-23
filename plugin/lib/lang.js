/**
 * The language the person reads dsh in (1a, 2026-10-10). dsh keeps it in its settings (`locale.preference`, owned by
 * dsh-client-locale: zh or en); without one the browser decides, which the host cannot see, so the system's locale
 * stands in. Only Chinese and English, as dsh ships.
 */
import { execFileSync } from 'node:child_process';
/** The first entry of a `defaults read -g AppleLanguages` listing, e.g. `(\n    "zh-Hans-HK",\n    en\n)`. */
export function firstAppleLanguage(listing) {
    return listing.match(/^\s*"?([A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{1,8})*)"?,?\s*$/m)?.[1];
}
let cachedSystemLocale;
/**
 * The system's language, standing in for the browser's. On macOS that is the first preferred language (System
 * Settings > Language & Region), which the browser follows; node's Intl does not read it and, with no LANG in the
 * environment (dsh started from the app or over ssh), says en-US (2026-10-11: a zh-Hans Mac got English answers and
 * dialogs). Read once per process; Intl when the listing cannot be read.
 */
export function systemLocale() {
    if (cachedSystemLocale !== undefined)
        return cachedSystemLocale;
    let tag;
    if (process.platform === 'darwin') {
        try {
            tag = firstAppleLanguage(execFileSync('/usr/bin/defaults', ['read', '-g', 'AppleLanguages'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }));
        }
        catch {
            tag = undefined;
        }
    }
    cachedSystemLocale = tag ?? Intl.DateTimeFormat().resolvedOptions().locale;
    return cachedSystemLocale;
}
export function uiLanguage(settings, system = systemLocale) {
    let pref;
    try {
        pref = settings?.get?.('locale');
    }
    catch {
        pref = undefined; // the namespace is not registered (no locale plugin): the system decides
    }
    const p = pref?.preference;
    const tag = typeof p === 'string' && p !== '' ? p : typeof system === 'function' ? system() : system;
    return tag.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}
/**
 * The reply language with a person at this Mac (appApproval dialog; the maintainer, 2026-10-10): dsh's language, until
 * the person asks for another.
 * A message in another language is not such a request: the input method may just have been on the wrong one.
 */
export function languagePrompt(lang) {
    const name = lang === 'zh' ? 'Chinese (简体中文)' : 'English';
    return `Reply language: answer in ${name}, the language the user reads dsh in, whatever language these instructions, `
        + 'the tools or the screen use. Switch only when the user explicitly asks you to answer in another language, and '
        + 'then keep to that one until they ask again. A message written in another language is not such a request (the '
        + 'input method may simply have been set to it).';
}
/** What dsh's approval card says when typing needs the input source switched to ABC. */
export function imeApprovalReason(lang, appName, source, scope) {
    // The name the system shows ("简体拼音") is quoted; without one, the input source ID as it is.
    if (lang === 'zh') {
        const sourceName = source.name !== undefined ? `「${source.name}」` : source.id;
        return `computer use 要往「${appName}」里输入文字，需要把输入法从${sourceName}临时切到英文键盘（ABC），`
            + `${scope === 'call' ? '这次输入完立刻' : '任务结束时'}切回。切换期间其他应用也处在英文键盘下；`
            + '如果你正在用拼音打字，先打完再批准。';
    }
    const sourceName = source.name !== undefined ? `“${source.name}”` : source.id;
    return `computer use wants to type into “${appName}” and needs to switch the input source from ${sourceName} to `
        + `the English keyboard (ABC) for a moment; it switches back ${scope === 'call' ? 'right after this input' : 'when the task ends'}. `
        + 'While switched, other apps use the English keyboard too; if you are typing with an input method, finish first, then approve.';
}
