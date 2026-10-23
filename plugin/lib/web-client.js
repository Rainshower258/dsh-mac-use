window.__ModuleLoader__.load({
	id: "cu-runtime",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var __modules = {
			"api.js": function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RouteError = exports.routePath = void 0;
exports.post = post;
exports.act = act;
exports.asFailure = asFailure;
const routePath = (route) => `api/cu-runtime.${route}`;
exports.routePath = routePath;
class RouteError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'RouteError';
        this.code = code;
    }
}
exports.RouteError = RouteError;
function failureOf(body) {
    const outer = typeof body === 'object' && body !== null ? body : {};
    const inner = typeof outer.error === 'object' && outer.error !== null ? outer.error : outer;
    return {
        ...(typeof inner.code === 'string' ? { code: inner.code } : {}),
        ...(typeof inner.message === 'string' ? { message: inner.message } : {}),
    };
}
const refused = (body) => typeof body === 'object' && body !== null && body.ok === false;
async function post(route, signal) {
    let response;
    try {
        response = await fetch((0, exports.routePath)(route), signal === undefined ? { method: 'POST' } : { method: 'POST', signal });
    }
    catch (error) {
        if (signal?.aborted === true)
            throw error;
        throw new RouteError('network', error instanceof Error ? error.message : String(error));
    }
    const body = await response.json().catch(() => undefined);
    const failure = failureOf(body);
    if (response.status === 401 || response.status === 403) {
        throw new RouteError('unauthorized', failure.message ?? `HTTP ${response.status} ${response.statusText}`.trim());
    }
    if (!response.ok)
        throw new RouteError(failure.code ?? `http_${response.status}`, failure.message ?? response.statusText);
    if (refused(body)) {
        throw new RouteError(failure.code ?? 'bad_response', failure.message ?? 'the answer has ok: false and no error code');
    }
    return body;
}
async function act(op) {
    const body = await post(op);
    const fields = typeof body === 'object' && body !== null ? body : undefined;
    const stated = op === 'install' ? typeof fields?.phase === 'string' : fields?.ok === true;
    if (!stated)
        throw new RouteError('bad_response', `the ${op} answer states no success`);
    return body;
}
function asFailure(error) {
    if (error instanceof RouteError)
        return { code: error.code, message: error.message };
    const code = typeof error === 'object' && error !== null && typeof error.code === 'string'
        ? error.code : 'unknown';
    return { code, message: error instanceof Error ? error.message : String(error) };
}
			},
			"index.js": function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = exports.name = exports.PACKAGE = void 0;
exports.apply = apply;
const locale_ts_1 = require("./locale.js");
const index_ts_1 = require("./settings/locale/index.js");
const shell_ts_1 = require("./settings/shell.js");
exports.PACKAGE = 'cu-runtime';
exports.name = 'cu-runtime-client';
exports.inject = ['slots', 'locale'];
const dictionaries = { zh: { ...locale_ts_1.zh, ...index_ts_1.zh }, en: { ...locale_ts_1.en, ...index_ts_1.en } };
function apply(ctx) {
    ctx.effect(() => ctx.locale.register(locale_ts_1.NS, dictionaries));
    ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: exports.PACKAGE, locale: locale_ts_1.NS }, shell_ts_1.PluginPage));
}
			},
			"locale.js": function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.en = exports.zh = exports.NS = void 0;
exports.NS = 'cu-runtime-page';
exports.zh = {
    'summary.loading': '正在读取守护进程状态…',
    'summary.unreadable': '无法读取守护进程状态。',
    'summary.task': '正在安装守护进程：{phase}',
    'summary.sshSession': 'dsh 运行在 SSH 会话中：安装、签名与启动守护进程需要在本机图形界面中运行的 dsh。',
    'summary.noGui': 'dsh 不在图形会话中运行：安装、签名与启动守护进程需要在本机图形界面中运行的 dsh。',
    'summary.identityAmbiguous': '钥匙串里有多张名为 cu-runtime-signing 的证书，请只保留授予过权限的那一张。'
        + '在此之前无法安装、启动守护进程或为其授予权限。',
    'summary.identityChanged': '钥匙串中的签名证书 cu-runtime-signing 与上次签名或创建时使用的证书不同。'
        + '在确认当前证书之前，无法安装、更新、启动守护进程或为其授予权限。',
    'summary.identityChangedInstalledApp': '钥匙串中的签名证书 cu-runtime-signing 与已安装的 CURuntime.app 所用的证书不同。'
        + '在确认当前证书之前，无法安装、更新、启动守护进程或为其授予权限。',
    'summary.busySelf': '本 dsh 进程中先前加载的插件版本（pid {pid}）自 {since} 起仍在管理守护进程，'
        + '插件更新前开始的操作尚未结束。在其结束之前无法安装、启动、停止守护进程或为其授予权限；状态每秒刷新一次。',
    'summary.busyOther': '另一个 dsh 进程（pid {pid}）自 {since} 起正在管理守护进程。'
        + '在其结束之前无法安装、启动、停止守护进程或为其授予权限；状态每秒刷新一次。',
    'summary.notInstalled': '守护进程尚未安装。安装时在本机构建并签名，约需数分钟。',
    'summary.signature': '已安装的守护进程签名与本机签名身份不符，或不是正式版本（例如 bench 构建），需要重新安装。',
    'summary.outdated': '已安装的守护进程与插件中的源码不一致，建议更新。',
    'summary.permissions': '守护进程尚未获得辅助功能或屏幕录制权限。',
    'summary.stopped': '守护进程已安装，当前未运行。',
    'summary.unchecked': '守护进程为最新版本，正在运行；最近未检查辅助功能与屏幕录制权限，可点击「检查权限」重新检查。',
    'summary.ready': '守护进程为最新版本，正在运行。',
    'section.daemon': '守护进程',
    'section.environment': '环境',
    'section.modeCheck': '模式检查',
    'modeCheck.about': '检查本 dsh 主目录中每个 profile 的配置：cu_* 工具只出现在「电脑操作」模式中，且该模式开启 onlyCuTools、'
        + '以对话框确认应用、未关闭 exclusive；不加载其他电脑操作插件。',
    'modeCheck.ok': '正常',
    'modeCheck.problems': '{n} 项问题',
    'modeCheck.unchecked': '未检查',
    'modeCheck.checking': '正在检查…',
    'modeCheck.checkedAt': '检查时间：{at}',
    'action.modeCheckRefresh': '重新检查',
    'row.installed': '安装状态',
    'row.version': '已安装版本',
    'row.pluginVersion': '插件版本',
    'row.upToDate': '是否最新',
    'row.signature': '签名',
    'row.identity': '签名身份',
    'row.identitySha1': '签名证书 SHA-1',
    'row.identityKnown': '上次使用的证书 SHA-1',
    'row.identityKnownInstalledApp': '已安装应用的证书 SHA-1',
    'row.running': '运行状态',
    'row.accessibility': '辅助功能权限',
    'row.screenRecording': '屏幕录制权限',
    'row.clt': '命令行工具',
    'row.session': '会话',
    'value.none': '—',
    'value.installed': '已安装',
    'value.notInstalled': '未安装',
    'value.upToDate': '最新',
    'value.outdated': '需要更新',
    'value.signature.ok': '有效',
    'value.signature.mismatch': '与本机签名身份不符，或不是正式版本',
    'value.signature.unsigned': '未签名',
    'value.signature.missing': '无法读取签名',
    'value.signature.ambiguous': '无法核对（钥匙串里有多张同名证书）',
    'value.identityPresent': '已在钥匙串中',
    'value.identityMissing': '尚未创建（安装时创建）',
    'value.identityAmbiguous': '钥匙串里有多张同名证书',
    'value.identityChanged': '与上次签名或创建时使用的证书不同',
    'value.identityChangedInstalledApp': '与已安装应用所用的证书不同',
    'value.running': '运行中',
    'value.stopped': '未运行',
    'value.granted': '已授予',
    'value.notGranted': '未授予',
    'value.unchecked': '未检查',
    'value.cltInstalled': '已安装',
    'value.cltMissing': '未安装（构建守护进程需要 Xcode 命令行工具）',
    'value.guiSession': '本机图形会话',
    'value.sshSession': 'SSH 会话（无法签名或启动守护进程）',
    'value.noGui': '无图形会话（无法签名或启动守护进程）',
    'action.install': '安装守护进程',
    'action.update': '更新守护进程',
    'action.reinstall': '重新安装守护进程',
    'action.permissions': '授予权限',
    'action.selfcheck': '检查权限',
    'action.start': '启动',
    'action.stop': '停止',
    'action.restart': '重启',
    'action.cancel': '取消安装',
    'action.clt': '安装命令行工具',
    'action.acceptIdentity': '确认当前证书',
    'hint.pluginUpdate': '更新本插件：在 dsh 的插件页中移除本插件，再添加新版本的包。dsh 使用其 PATH 中的 pnpm 安装插件；'
        + '以 npm 安装的 dsh 不附带 pnpm，需先运行 npm i -g pnpm，否则添加插件时只显示「退出码 127」，没有其他输出。桌面版自带 pnpm。',
    'hint.permissions': '「授予权限」每次只打开系统设置中的一个面板：先打开「辅助功能」，在其中打开 CURuntime 的开关后，'
        + '点击「检查权限」；辅助功能显示为已授予后，再点击一次「授予权限」打开「屏幕录制」，同样打开开关后点击「检查权限」。'
        + '开关已经打开、检查仍显示未授予时，系统中留有与当前签名不符的旧授权记录（例如更换签名证书之后）：在本插件的源码目录运行 '
        + 'zsh scripts/install.sh --permissions-only，它只清除未生效的记录，然后再点击「授予权限」。',
    'identity.changed': '钥匙串中名为 cu-runtime-signing 的证书（「签名证书 SHA-1」）不是{known}。'
        + '确认之前，请读出备份证书的 SHA-1，与「签名证书 SHA-1」逐位对照。'
        + '可作参照的是保存在这台 Mac 之外的 .p12 备份（或同样保存在这台 Mac 之外的 cert.pem），本用户的进程无法替换它：'
        + '下面第一条命令读出 .p12 中证书的 SHA-1，将 <backup.p12> 换成备份文件的路径（会要求输入 .p12 的密码，不会写出私钥；'
        + '读完后不要把 .p12 和它的密码一起留在这台 Mac 上）；保存在别处的 cert.pem 用第二条命令，将路径换成它的路径。'
        + '第二条命令原样读取的 ~/.cu-runtime-signing/cert.pem 是 make-signing-identity.sh 在本机保存的副本，只为方便核对：'
        + '本用户的任何进程都能改写它，与它一致不能排除同名的仿冒证书。'
        + '它旁边有 cert.pem.replaced-* 文件，说明 cert.pem 被改写过（make-signing-identity.sh 重新创建签名身份时会这样做），'
        + '确认之前应先查明原因。'
        + '备份证书的 SHA-1 与「签名证书 SHA-1」一致，说明当前证书就是备份的那一张（例如从备份重新导入），'
        + '可点击「确认当前证书」，此后的安装以它为准；两者不一致时请勿确认，应先查明钥匙串中这张证书的来历。'
        + '没有保存在别处的备份时，无法用这一方法可靠核对。',
    'identity.known': '上次签名或创建时使用的那一张（「上次使用的证书 SHA-1」）',
    'identity.knownInstalledApp': '已安装的 CURuntime.app 所用的那一张（「已安装应用的证书 SHA-1」）',
    'identity.changedAgain': '本页显示之后，钥匙串中的证书又发生了变化，已拒绝确认。'
        + '请对照本页重新读取的「签名证书 SHA-1」，核对无误后再确认。',
    'phase.preflight': '检查环境',
    'phase.identity': '准备签名身份',
    'phase.copy': '复制源码',
    'phase.build': '构建',
    'phase.sign': '签名',
    'phase.verify': '校验签名',
    'phase.stop': '停止旧守护进程',
    'phase.replace': '替换应用',
    'phase.start': '启动守护进程',
    'phase.selfcheck': '自检',
    'task.running': '正在安装守护进程',
    'task.done': '安装完成',
    'task.failed': '安装失败',
    'task.cancelled': '安装已取消',
    'task.step': '第 {index} 步，共 {total} 步：{phase}',
    'task.log': '日志（最后 {count} 行）',
    'task.keychain': '签名时 macOS 会弹出钥匙串对话框，要求输入登录钥匙串的密码，以允许 codesign 使用签名身份 '
        + 'cu-runtime-signing 的私钥；对话框可能不止出现一次。每次都请输入登录钥匙串密码并选择「允许」，不要选择「始终允许」：'
        + '选择「始终允许」后，之后的签名不再需要确认，而这一确认正是安装守护进程的人工把关。',
    'task.noCancel': '已开始替换应用，此时无法取消。',
    'task.openDialog': '钥匙串的密码对话框可能仍未关闭：签名因失败、取消或超时而结束时，macOS 不会随之关闭该对话框。'
        + '若屏幕上仍有该对话框，请选择「拒绝」将其关闭（无需输入密码），它已不再用于本次安装。',
    'notice.permissions': '已打开系统设置中的一个权限面板（辅助功能尚未显示为已授予时为「辅助功能」，否则为「屏幕录制」）。'
        + '在其中打开 CURuntime 的开关后，请点击「检查权限」。授予屏幕录制权限后可能需要重启守护进程。',
    'notice.clt': '已请求安装 Xcode 命令行工具，请在系统对话框中完成安装。安装完成后状态会自动刷新。',
    'error.busy': '安装任务或另一项操作（可能来自另一个 dsh 进程）正在进行，请稍后重试。',
    'error.ssh_session': 'dsh 运行在 SSH 会话中，无法签名或启动守护进程。请在本机图形界面中运行 dsh 后重试。',
    'error.no_gui_session': 'dsh 不在本机的图形会话中运行，无法签名或启动守护进程。请在本机图形界面中运行 dsh 后重试。',
    'error.clt_missing': '未安装 Xcode 命令行工具。请先安装命令行工具，完成后再安装守护进程。',
    'error.identity_failed': '无法在钥匙串中创建签名身份 cu-runtime-signing，详见日志。',
    'error.identity_ambiguous': '钥匙串里有多张名为 cu-runtime-signing 的证书，请只保留授予过权限的那一张，然后重试。',
    'error.identity_missing': '钥匙串里没有签名身份 cu-runtime-signing，无法核对已安装守护进程的签名，已拒绝此操作。'
        + '请重新安装守护进程。',
    'error.identity_changed': '钥匙串中的签名证书 cu-runtime-signing 与上次签名或创建时使用的证书（尚无记录时为已安装应用所用的证书）不同，已拒绝安装。'
        + '请先在本页对照两张证书的 SHA-1，确认当前证书后再安装。',
    'error.copy_failed': '无法将源码复制到构建目录，详见日志。',
    'error.build_failed': '构建守护进程失败，详见日志。',
    'error.not_release_build': '应用不是正式版本（Info.plist 中的 CUBench 不为 false，或签名时未启用 hardened runtime），已拒绝此操作：构建出的此类版本不会替换 '
        + '~/Applications 中的守护进程，已安装的此类版本（例如 bench 构建）不会被启动、重启、检查权限或授予权限。请重新安装守护进程。',
    'error.sign_failed': '签名失败。若钥匙串的密码对话框被取消，或选择了「拒绝」，请重新安装，并在对话框中输入登录钥匙串密码、'
        + '选择「允许」。',
    'error.signature_mismatch': '已安装的守护进程签名与本机签名身份不符，已拒绝启动。请重新安装守护进程。',
    'error.stop_failed': '守护进程未在限定时间内退出。',
    'error.replace_failed': '无法替换 ~/Applications 中的 CURuntime.app，详见日志。',
    'error.start_failed': '无法启动 CURuntime。',
    'error.selfcheck_failed': '守护进程自检失败。',
    'error.selfcheck_timeout': '守护进程自检未在限定时间内给出结果。',
    'error.not_installed': '守护进程尚未安装，请先安装守护进程。',
    'error.clt_install_failed': '无法打开 Xcode 命令行工具的安装程序（安装可能已在进行中，或已经安装）。',
    'error.no_task': '当前没有进行中的安装任务。',
    'error.not_cancellable': '已开始替换应用，安装任务无法取消。',
    'error.internal': '宿主服务发生内部错误。',
    'error.unauthorized': '登录已失效，请刷新页面后重试。',
    'error.network': '无法连接 dsh。',
    'error.bad_response': 'dsh 的回答格式不符，插件页面可能与宿主服务版本不一致。',
    'error.phaseFailed': '「{phase}」这一步失败。',
    'error.unknown': '操作失败（{code}）。',
    'error.detail': '详情：{message}',
};
exports.en = {
    'summary.loading': 'Reading the daemon\'s status…',
    'summary.unreadable': 'The daemon\'s status could not be read.',
    'summary.task': 'Installing the daemon: {phase}',
    'summary.sshSession': 'dsh runs in an SSH session: installing, signing and starting the daemon need dsh running in '
        + 'this Mac\'s graphical session.',
    'summary.noGui': 'dsh does not run in a graphical session: installing, signing and starting the daemon need dsh '
        + 'running in this Mac\'s graphical session.',
    'summary.identityAmbiguous': 'The keychain holds more than one certificate named cu-runtime-signing; keep only the '
        + 'one the permissions were granted to. Until then the daemon cannot be installed, started or granted permissions.',
    'summary.identityChanged': 'The signing certificate cu-runtime-signing in the keychain differs from the one last '
        + 'signed with or created. Until the current certificate is accepted, the daemon cannot be installed, updated, '
        + 'started or granted permissions.',
    'summary.identityChangedInstalledApp': 'The signing certificate cu-runtime-signing in the keychain differs from the '
        + 'one the installed CURuntime.app was signed with. Until the current certificate is accepted, the daemon cannot be '
        + 'installed, updated, started or granted permissions.',
    'summary.busySelf': 'An earlier version of this plugin, loaded before in this dsh process (pid {pid}), has been '
        + 'managing the daemon since {since}: an operation begun before the plugin was updated is still finishing. Until it '
        + 'ends, the daemon cannot be installed, started, stopped or granted permissions; the status is read every second.',
    'summary.busyOther': 'Another dsh process (pid {pid}) has been managing the daemon since {since}. Until it ends, the '
        + 'daemon cannot be installed, started, stopped or granted permissions; the status is read every second.',
    'summary.notInstalled': 'The daemon is not installed. Installing builds and signs it on this Mac, which takes a few minutes.',
    'summary.signature': 'The installed daemon\'s signature does not match this Mac\'s signing identity, or it is not a '
        + 'release build (a bench build, for example); it needs to be installed again.',
    'summary.outdated': 'The installed daemon differs from the sources in the plugin; an update is recommended.',
    'summary.permissions': 'The daemon does not have the Accessibility or Screen Recording permission yet.',
    'summary.stopped': 'The daemon is installed and not running.',
    'summary.unchecked': 'The daemon is up to date and running; its Accessibility and Screen Recording permissions have '
        + 'not been checked recently (Check permissions checks them).',
    'summary.ready': 'The daemon is up to date and running.',
    'section.daemon': 'Daemon',
    'section.environment': 'Environment',
    'section.modeCheck': 'Mode check',
    'modeCheck.about': 'Checks the config of every profile in this dsh home: the cu_* tools only in the 电脑操作 mode, '
        + 'with onlyCuTools on, apps approved by dialog and exclusive not switched off; no other computer-use plugin.',
    'modeCheck.ok': 'OK',
    'modeCheck.problems': 'Problems: {n}',
    'modeCheck.unchecked': 'Not checked',
    'modeCheck.checking': 'Checking…',
    'modeCheck.checkedAt': 'Checked at {at}',
    'action.modeCheckRefresh': 'Check again',
    'row.installed': 'Installed',
    'row.version': 'Installed version',
    'row.pluginVersion': 'Plugin version',
    'row.upToDate': 'Up to date',
    'row.signature': 'Signature',
    'row.identity': 'Signing identity',
    'row.identitySha1': 'Certificate SHA-1',
    'row.identityKnown': 'Certificate SHA-1 last used',
    'row.identityKnownInstalledApp': 'Installed app\'s certificate SHA-1',
    'row.running': 'Running',
    'row.accessibility': 'Accessibility',
    'row.screenRecording': 'Screen Recording',
    'row.clt': 'Command Line Tools',
    'row.session': 'Session',
    'value.none': '—',
    'value.installed': 'Installed',
    'value.notInstalled': 'Not installed',
    'value.upToDate': 'Up to date',
    'value.outdated': 'Needs an update',
    'value.signature.ok': 'Valid',
    'value.signature.mismatch': 'Does not match this Mac\'s signing identity, or not a release build',
    'value.signature.unsigned': 'Unsigned',
    'value.signature.missing': 'Could not be read',
    'value.signature.ambiguous': 'Cannot be checked (more than one certificate of that name in the keychain)',
    'value.identityPresent': 'In the keychain',
    'value.identityMissing': 'Not created yet (created when installing)',
    'value.identityAmbiguous': 'More than one certificate of that name in the keychain',
    'value.identityChanged': 'Differs from the certificate last signed with or created',
    'value.identityChangedInstalledApp': 'Differs from the certificate the installed app was signed with',
    'value.running': 'Running',
    'value.stopped': 'Not running',
    'value.granted': 'Granted',
    'value.notGranted': 'Not granted',
    'value.unchecked': 'Not checked',
    'value.cltInstalled': 'Installed',
    'value.cltMissing': 'Not installed (building the daemon needs the Xcode Command Line Tools)',
    'value.guiSession': 'Graphical session on this Mac',
    'value.sshSession': 'SSH session (the daemon cannot be signed or started)',
    'value.noGui': 'No graphical session (the daemon cannot be signed or started)',
    'action.install': 'Install the daemon',
    'action.update': 'Update the daemon',
    'action.reinstall': 'Reinstall the daemon',
    'action.permissions': 'Grant permissions',
    'action.selfcheck': 'Check permissions',
    'action.start': 'Start',
    'action.stop': 'Stop',
    'action.restart': 'Restart',
    'action.cancel': 'Cancel the install',
    'action.clt': 'Install the Command Line Tools',
    'action.acceptIdentity': 'Accept the current certificate',
    'hint.pluginUpdate': 'To update this plugin, remove it on dsh\'s plugin page and add the new package. dsh installs plugins '
        + 'with the pnpm on its PATH; a dsh installed with npm brings none, so run npm i -g pnpm first, or adding a plugin '
        + 'shows only exit code 127 and no other output. The desktop app brings its own pnpm.',
    'hint.permissions': 'Grant permissions opens one System Settings pane per click: first Accessibility. Turn CURuntime '
        + 'on there, then click Check permissions; once Accessibility shows as granted, click Grant permissions again for '
        + 'Screen Recording, turn it on there too and click Check permissions. If the switch is on and the check still shows '
        + 'the permission missing, an old grant row that does not match the current signature is left (after a certificate '
        + 'change, for example): run zsh scripts/install.sh --permissions-only in this plugin\'s source folder, which clears only rows not in '
        + 'effect, then click Grant permissions again.',
    'identity.changed': 'The certificate named cu-runtime-signing in the keychain (Certificate SHA-1) is not {known}. '
        + 'Before accepting it, read the SHA-1 of the backed-up certificate and compare it with Certificate SHA-1 digit by '
        + 'digit. The reference is the .p12 backup kept off this Mac (or a cert.pem kept off this Mac as well), which no '
        + 'process of this user can swap: the first command below reads the SHA-1 of the certificate in a .p12, with the '
        + 'backup\'s path for <backup.p12> (it asks for the .p12\'s password and writes no key; do not leave the .p12 and its '
        + 'password on this Mac together afterwards); for a cert.pem kept elsewhere, use the second with its path. As it '
        + 'stands, the second reads ~/.cu-runtime-signing/cert.pem, the copy make-signing-identity.sh kept on this Mac, which '
        + 'is only a convenience: any process of this user can rewrite it, so a match with it does not rule out a look-alike '
        + 'of the same name. A cert.pem.replaced-* next to it means cert.pem was rewritten (make-signing-identity.sh does '
        + 'that when it makes the identity again); find out why before accepting. If the backed-up certificate\'s SHA-1 '
        + 'matches Certificate SHA-1, the current certificate is the backed-up one (re-imported from the backup, for '
        + 'example): Accept the current certificate, and later installs go by it. If they differ, do not accept it; find out '
        + 'first where the certificate in the keychain came from. Without a backup kept elsewhere this check cannot be '
        + 'made reliably.',
    'identity.known': 'the one last signed with or created (Certificate SHA-1 last used)',
    'identity.knownInstalledApp': 'the one the installed CURuntime.app was signed with (Installed app\'s certificate SHA-1)',
    'identity.changedAgain': 'The certificate in the keychain changed again after this page showed it, so it was not '
        + 'accepted. Compare the Certificate SHA-1 this page has read again before accepting it.',
    'phase.preflight': 'Checking the environment',
    'phase.identity': 'Preparing the signing identity',
    'phase.copy': 'Copying the sources',
    'phase.build': 'Building',
    'phase.sign': 'Signing',
    'phase.verify': 'Verifying the signature',
    'phase.stop': 'Stopping the old daemon',
    'phase.replace': 'Replacing the app',
    'phase.start': 'Starting the daemon',
    'phase.selfcheck': 'Self-check',
    'task.running': 'Installing the daemon',
    'task.done': 'Installed',
    'task.failed': 'The install failed',
    'task.cancelled': 'The install was cancelled',
    'task.step': 'Step {index} of {total}: {phase}',
    'task.log': 'Log (last {count} lines)',
    'task.keychain': 'While signing, macOS shows a keychain dialog asking for the login keychain password so that '
        + 'codesign may use the private key of the cu-runtime-signing identity; it may appear more than once. Each time, '
        + 'enter the login keychain password and choose Allow, not Always Allow: after Always Allow, later signing is no '
        + 'longer confirmed, and that confirmation is what guards installing the daemon.',
    'task.noCancel': 'The app is being replaced; the install can no longer be cancelled.',
    'task.openDialog': 'A keychain password dialog may still be open: when signing ends by a failure, a cancel or a '
        + 'timeout, macOS does not close it. If it is still on screen, close it with Deny (no password needed); it no '
        + 'longer serves this install.',
    'notice.permissions': 'System Settings opened at one permission pane (Accessibility while it does not show as '
        + 'granted, else Screen Recording). Turn CURuntime on there, then click Check permissions. After granting Screen '
        + 'Recording the daemon may need a restart.',
    'notice.clt': 'The Xcode Command Line Tools install was requested; finish it in the system dialog. The status refreshes '
        + 'by itself once it is done.',
    'error.busy': 'An install task or another action (possibly from another dsh process) is in progress; try again shortly.',
    'error.ssh_session': 'dsh runs in an SSH session, where the daemon cannot be signed or started. Run dsh in this '
        + 'Mac\'s graphical session and try again.',
    'error.no_gui_session': 'dsh does not run in this Mac\'s graphical session, so the daemon cannot be signed or '
        + 'started. Run dsh in this Mac\'s graphical session and try again.',
    'error.clt_missing': 'The Xcode Command Line Tools are not installed. Install them first, then install the daemon.',
    'error.identity_failed': 'The signing identity cu-runtime-signing could not be created in the keychain; see the log.',
    'error.identity_ambiguous': 'The keychain holds more than one certificate named cu-runtime-signing; keep only the '
        + 'one the permissions were granted to, then try again.',
    'error.identity_missing': 'The keychain has no signing identity cu-runtime-signing to check the installed daemon '
        + 'against, so the operation was refused. Install the daemon again.',
    'error.identity_changed': 'The signing certificate cu-runtime-signing in the keychain differs from the one last '
        + 'signed with or created (with no record yet, the one the installed app was signed with), so the install was refused. Compare the two certificates\' SHA-1 on this page and accept '
        + 'the current one before installing.',
    'error.copy_failed': 'The sources could not be copied to the build directory; see the log.',
    'error.build_failed': 'Building the daemon failed; see the log.',
    'error.not_release_build': 'The app is not a release build (CUBench in its Info.plist is not false, or it was signed without hardened '
        + 'runtime), so the operation '
        + 'was refused: such a build never replaces the daemon in ~/Applications, and an installed one (a bench build, for '
        + 'example) is not started, restarted, checked or granted permissions. Install the daemon again.',
    'error.sign_failed': 'Signing failed. If the keychain password dialog was cancelled or answered with Deny, install '
        + 'again, enter the login keychain password and choose Allow.',
    'error.signature_mismatch': 'The installed daemon\'s signature does not match this Mac\'s signing identity, so it '
        + 'was not started. Install the daemon again.',
    'error.stop_failed': 'The daemon did not exit in time.',
    'error.replace_failed': 'CURuntime.app in ~/Applications could not be replaced; see the log.',
    'error.start_failed': 'CURuntime could not be started.',
    'error.selfcheck_failed': 'The daemon\'s self-check failed.',
    'error.selfcheck_timeout': 'The daemon\'s self-check gave no result in time.',
    'error.not_installed': 'The daemon is not installed; install it first.',
    'error.clt_install_failed': 'The Xcode Command Line Tools installer could not be opened (an install may already be '
        + 'running, or they may be installed already).',
    'error.no_task': 'No install task is running.',
    'error.not_cancellable': 'The app is being replaced; the install can no longer be cancelled.',
    'error.internal': 'The host service ran into an internal error.',
    'error.unauthorized': 'The sign-in is no longer valid; reload the page and try again.',
    'error.network': 'dsh could not be reached.',
    'error.bad_response': 'dsh answered in an unexpected shape; the plugin page and the host service may be from '
        + 'different versions.',
    'error.phaseFailed': 'The step "{phase}" failed.',
    'error.unknown': 'The operation failed ({code}).',
    'error.detail': 'Details: {message}',
};
			},
			"page.js": function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ACTION_ERROR_MS = exports.IDLE_POLL_MS = exports.ACTIVE_POLL_MS = void 0;
exports.ModeCheckSection = ModeCheckSection;
exports.Page = Page;
const react_1 = require("react");
const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
const api_ts_1 = require("./api.js");
const ui_ts_1 = require("./settings/ui.js");
const view_ts_1 = require("./view.js");
exports.ACTIVE_POLL_MS = 1000;
exports.IDLE_POLL_MS = 10_000;
exports.ACTION_ERROR_MS = 30_000;
const present = (component) => typeof component === 'function' || (typeof component === 'object' && component !== null);
const STYLE = {
    page: { display: 'flex', flexDirection: 'column', gap: 16, fontSize: 13, lineHeight: 1.5, minWidth: 0 },
    line: { display: 'flex', alignItems: 'center', gap: 8, margin: 0, minWidth: 0 },
    section: { display: 'grid', gap: 8, minWidth: 0 },
    heading: { margin: 0, fontSize: 13, fontWeight: 600 },
    rows: { display: 'grid', gridTemplateColumns: 'minmax(96px, max-content) minmax(0, 1fr)', columnGap: 16, rowGap: 6, margin: 0 },
    label: { color: 'var(--dsw-alias-label-secondary)' },
    value: { display: 'flex', alignItems: 'center', gap: 6, margin: 0, minWidth: 0, overflowWrap: 'anywhere' },
    actions: { display: 'flex', flexWrap: 'wrap', gap: 8 },
    task: { display: 'grid', gap: 8, padding: 14, border: '.5px solid var(--dsw-alias-border-l1)', borderRadius: 10, minWidth: 0 },
    quiet: { margin: 0, color: 'var(--dsw-alias-label-secondary)' },
    warn: { margin: 0, color: 'var(--dsw-alias-state-warn-primary)' },
    error: { margin: 0, color: 'var(--dsw-alias-state-error-primary)', overflowWrap: 'anywhere' },
    code: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, overflowWrap: 'anywhere' },
    log: {
        margin: 0, padding: 8, maxHeight: 200, overflow: 'auto', borderRadius: 6, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11,
        color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-bg-module-platform)',
    },
    modeCheckList: {
        margin: 0, padding: '6px 8px 6px 24px', maxHeight: 160, overflow: 'auto', borderRadius: 6, overflowWrap: 'anywhere',
        fontSize: 12, background: 'var(--dsw-alias-bg-module-platform)',
    },
    button: {
        padding: '4px 12px', borderRadius: 8, border: ui_ts_1.BUTTON_BORDER,
        background: 'none', color: 'inherit', font: 'inherit',
    },
};
const DOT_COLOR = {
    done: 'var(--dsw-alias-state-success-primary)',
    warning: 'var(--dsw-alias-state-warn-primary)',
    ongoing: 'var(--dsw-alias-state-business-primary)',
    error: 'var(--dsw-alias-state-error-primary)',
    idle: 'var(--dsw-alias-state-idle-primary)',
};
function dot(state) {
    const { StateDot } = primitives;
    if (present(StateDot))
        return (0, react_1.createElement)(StateDot, { state });
    return (0, react_1.createElement)('span', { 'aria-hidden': true, 'data-state': state,
        style: { flex: 'none', width: 8, height: 8, borderRadius: '50%', background: DOT_COLOR[state] } });
}
function tag(text) {
    const { Tag } = primitives;
    return present(Tag) ? (0, react_1.createElement)(Tag, { tone: 'neutral' }, text) : (0, react_1.createElement)('span', null, text);
}
function button(action, run) {
    const { Button } = primitives;
    const props = { key: action.op, disabled: !action.enabled, onClick: () => run(action.op) };
    return present(Button)
        ? (0, react_1.createElement)(Button, { ...props, variant: action.variant, size: 'sm',
            ...(action.variant === 'primary' ? {} : { style: { border: ui_ts_1.BUTTON_BORDER } }) }, action.label)
        : (0, react_1.createElement)('button', { ...props, type: 'button', style: { ...STYLE.button, opacity: action.enabled ? 1 : 0.5 } }, action.label);
}
const SHA1_ROWS = new Set(['identitySha1', 'identityKnown']);
function row(r, none) {
    const value = r.value === none ? (0, react_1.createElement)('span', null, r.value)
        : r.id === 'version' || r.id === 'pluginVersion' ? tag(r.value)
            : SHA1_ROWS.has(r.id) ? (0, react_1.createElement)('code', { style: STYLE.code }, r.value)
                : (0, react_1.createElement)('span', null, r.value);
    return [
        (0, react_1.createElement)('dt', { key: `${r.id}:label`, style: STYLE.label }, r.label),
        (0, react_1.createElement)('dd', { key: `${r.id}:value`, style: STYLE.value }, r.state === null ? null : dot(r.state), value),
    ];
}
function section(s, none) {
    return (0, react_1.createElement)('section', { key: s.id, style: STYLE.section }, (0, react_1.createElement)('h4', { style: STYLE.heading }, s.title), (0, react_1.createElement)('dl', { style: STYLE.rows }, ...s.rows.flatMap((r) => row(r, none))));
}
function identityChange(view) {
    return (0, react_1.createElement)('section', { style: STYLE.task, 'data-cu-runtime-identity': '' }, (0, react_1.createElement)('p', { style: STYLE.warn }, view.text), ...view.commands.map((command) => (0, react_1.createElement)('code', { key: command, style: STYLE.code }, command)));
}
function task(view) {
    return (0, react_1.createElement)('section', { style: STYLE.task, 'aria-live': 'polite' }, (0, react_1.createElement)('p', { style: { ...STYLE.line, fontWeight: 600 } }, dot(view.state), (0, react_1.createElement)('span', null, view.title)), view.step === null ? null : (0, react_1.createElement)('p', { style: STYLE.quiet }, view.step), view.keychain === null ? null : (0, react_1.createElement)('p', { style: STYLE.warn }, view.keychain), view.note === null ? null : (0, react_1.createElement)('p', { style: STYLE.quiet }, view.note), view.error === null ? null : (0, react_1.createElement)('p', { style: STYLE.error }, view.error.text), view.error?.detail == null ? null : (0, react_1.createElement)('p', { style: STYLE.error }, view.error.detail), view.openDialog === null ? null : (0, react_1.createElement)('p', { style: STYLE.warn }, view.openDialog), view.log.length === 0 ? null : (0, react_1.createElement)('p', { style: STYLE.quiet }, view.logTitle), view.log.length === 0 ? null : (0, react_1.createElement)('pre', { style: STYLE.log }, view.log.join('\n')));
}
function plainButton(key, label, enabled, onClick) {
    const { Button } = primitives;
    const props = { key, disabled: !enabled, onClick };
    const border = { style: { border: ui_ts_1.BUTTON_BORDER } };
    return present(Button)
        ? (0, react_1.createElement)(Button, { ...props, variant: 'outline', size: 'sm', ...border }, label)
        : (0, react_1.createElement)('button', { ...props, type: 'button', style: { ...STYLE.button, opacity: enabled ? 1 : 0.5 } }, label);
}
function ModeCheckSection({ t }) {
    const [result, setResult] = (0, react_1.useState)(null);
    const [pending, setPending] = (0, react_1.useState)(true);
    const [error, setError] = (0, react_1.useState)(null);
    const [round, setRound] = (0, react_1.useState)(0);
    (0, react_1.useEffect)(() => {
        let stopped = false;
        setPending(true);
        (0, api_ts_1.post)(round === 0 ? 'modeCheck' : 'modeCheckRefresh').then((body) => {
            if (stopped)
                return;
            setResult((0, view_ts_1.readModeCheck)(body));
            setError(null);
        }).catch((e) => {
            if (!stopped)
                setError((0, api_ts_1.asFailure)(e));
        }).finally(() => {
            if (!stopped)
                setPending(false);
        });
        return () => { stopped = true; };
    }, [round]);
    const view = (0, view_ts_1.buildModeCheckView)(result, { t, pending, error });
    return (0, react_1.createElement)('section', { style: STYLE.section, 'data-cu-runtime-mode-check': '' }, (0, react_1.createElement)('h4', { style: STYLE.heading }, view.title), (0, react_1.createElement)('p', { style: STYLE.quiet }, view.about), (0, react_1.createElement)('p', { style: STYLE.line, role: 'status' }, dot(view.state), (0, react_1.createElement)('span', null, view.text)), view.lines.length === 0 ? null
        : (0, react_1.createElement)('ul', { style: STYLE.modeCheckList }, ...view.lines.map((line, i) => (0, react_1.createElement)('li', { key: String(i) }, line))), view.checkedAt === null ? null : (0, react_1.createElement)('p', { style: STYLE.quiet }, view.checkedAt), view.error === null ? null : (0, react_1.createElement)('div', { role: 'alert' }, (0, react_1.createElement)('p', { style: STYLE.error }, view.error.text), view.error.detail === null ? null : (0, react_1.createElement)('p', { style: STYLE.error }, view.error.detail)), (0, react_1.createElement)('div', { style: STYLE.actions }, plainButton('modeCheckRefresh', view.refresh.label, view.refresh.enabled, () => setRound((n) => n + 1))));
}
function Page({ t, view: shownAs }) {
    const [status, setStatus] = (0, react_1.useState)(null);
    const [statusError, setStatusError] = (0, react_1.useState)(null);
    const [pending, setPending] = (0, react_1.useState)(null);
    const [done, setDone] = (0, react_1.useState)(null);
    const [actionError, setActionError] = (0, react_1.useState)(null);
    const [round, setRound] = (0, react_1.useState)(0);
    (0, react_1.useEffect)(() => {
        let stopped = false;
        let timer;
        let active = false;
        const controller = new AbortController();
        const poll = async () => {
            const began = Date.now();
            const settle = () => setActionError((shown) => shown !== null && began - shown.at >= exports.ACTION_ERROR_MS ? null : shown);
            try {
                const next = (0, view_ts_1.readStatus)(await (0, api_ts_1.post)('status', controller.signal));
                if (stopped)
                    return;
                active = (0, view_ts_1.taskActive)(next.task) || (0, view_ts_1.heldElsewhere)(next);
                setStatus(next);
                setStatusError(null);
                settle();
            }
            catch (error) {
                if (stopped)
                    return;
                setStatusError((0, api_ts_1.asFailure)(error));
                settle();
            }
            timer = setTimeout(() => void poll(), active ? exports.ACTIVE_POLL_MS : exports.IDLE_POLL_MS);
        };
        void poll();
        return () => {
            stopped = true;
            clearTimeout(timer);
            controller.abort();
        };
    }, [round]);
    const run = (0, react_1.useCallback)((op) => {
        setPending(op);
        setDone(null);
        setActionError(null);
        (0, api_ts_1.act)(op).then(() => setDone(op), (error) => setActionError({ failure: (0, api_ts_1.asFailure)(error), op, at: Date.now() })).finally(() => {
            setPending(null);
            setRound((n) => n + 1);
        });
    }, []);
    const view = (0, view_ts_1.buildView)(status, {
        t, pending, done, actionError: actionError?.failure ?? null, actionErrorOp: actionError?.op ?? null, statusError,
    });
    return (0, react_1.createElement)('div', { style: STYLE.page, 'data-cu-runtime-page': '' }, (0, react_1.createElement)('p', { style: STYLE.line, role: 'status' }, dot(view.summary.state), (0, react_1.createElement)('span', null, view.summary.text)), view.error === null ? null : (0, react_1.createElement)('div', { role: 'alert' }, (0, react_1.createElement)('p', { style: STYLE.error }, view.error.text), view.error.detail === null ? null : (0, react_1.createElement)('p', { style: STYLE.error }, view.error.detail)), ...view.sections.map((s) => section(s, t('value.none'))), view.identityChange === null ? null : identityChange(view.identityChange), view.actions.length === 0 ? null : (0, react_1.createElement)('div', { style: STYLE.actions }, ...view.actions.map((a) => button(a, run))), view.permissionsHint === null ? null : (0, react_1.createElement)('p', { style: STYLE.quiet }, view.permissionsHint), view.notice === null ? null : (0, react_1.createElement)('p', { style: STYLE.quiet }, view.notice), view.task === null ? null : task(view.task), shownAs === 'summary' ? null : (0, react_1.createElement)(ModeCheckSection, { t }), (0, react_1.createElement)('p', { style: STYLE.quiet }, view.pluginUpdateHint));
}
			},
			"settings/api.js": function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SettingsRouteError = exports.settingsPath = exports.PAGE_HEADER = void 0;
exports.fetchSnapshot = fetchSnapshot;
exports.applyChange = applyChange;
exports.cancelVerify = cancelVerify;
exports.runAction = runAction;
exports.asSettingsFailure = asSettingsFailure;
const model_ts_1 = require("./model.js");
exports.PAGE_HEADER = 'x-cu-runtime-page';
const settingsPath = (route) => `api/cu-runtime.${route}`;
exports.settingsPath = settingsPath;
class SettingsRouteError extends Error {
    code;
    data;
    constructor(code, message, data) {
        super(message);
        this.name = 'SettingsRouteError';
        this.code = code;
        if (data !== undefined)
            this.data = data;
    }
}
exports.SettingsRouteError = SettingsRouteError;
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
function errorOf(body) {
    const error = isObject(body) && isObject(body.error) ? body.error : {};
    const until = isObject(error.data) ? error.data.until : undefined;
    return {
        ...(typeof error.code === 'string' ? { code: error.code } : {}),
        ...(typeof error.message === 'string' ? { message: error.message } : {}),
        ...(typeof until === 'number' && Number.isFinite(until) ? { data: { until } } : {}),
    };
}
async function postSettings(route, key, body, signal) {
    const init = body === undefined ? { method: 'POST' }
        : { method: 'POST', headers: { 'content-type': 'application/json', [exports.PAGE_HEADER]: '1' }, body: JSON.stringify(body) };
    if (signal !== undefined)
        init.signal = signal;
    let response;
    try {
        response = await fetch((0, exports.settingsPath)(route), init);
    }
    catch (error) {
        if (signal?.aborted === true)
            throw error;
        throw new SettingsRouteError('network', error instanceof Error ? error.message : String(error));
    }
    const answer = await response.json().catch(() => undefined);
    const failure = errorOf(answer);
    if (response.status === 401 || response.status === 403) {
        throw new SettingsRouteError('unauthorized', failure.message ?? `HTTP ${response.status} ${response.statusText}`.trim());
    }
    if (!response.ok)
        throw new SettingsRouteError(failure.code ?? `http_${response.status}`, failure.message ?? response.statusText, failure.data);
    if (isObject(answer) && answer.ok === false) {
        throw new SettingsRouteError(failure.code ?? 'bad_response', failure.message ?? 'the answer has ok: false and no error code', failure.data);
    }
    if (!isObject(answer) || answer.ok !== true || !isObject(answer[key])) {
        throw new SettingsRouteError('bad_response', `the ${route} answer has no ${key}`);
    }
    return answer[key];
}
function readResult(route, raw) {
    if (typeof raw.status !== 'string')
        throw new SettingsRouteError('bad_response', `the ${route} result has no status`);
    return {
        status: raw.status,
        ...(isObject(raw.summary) && typeof raw.summary.kind === 'string' ? { summary: raw.summary } : {}),
        ...(typeof raw.panel === 'string' ? { panel: raw.panel } : {}),
    };
}
async function fetchSnapshot(signal) {
    try {
        return (0, model_ts_1.readSnapshot)(await postSettings('settings.snapshot', 'snapshot', undefined, signal));
    }
    catch (error) {
        if (error instanceof Error && !(error instanceof SettingsRouteError) && error.code === 'bad_response') {
            throw new SettingsRouteError('bad_response', error.message);
        }
        throw error;
    }
}
async function applyChange(change) {
    return readResult('settings.apply', await postSettings('settings.apply', 'result', { change }));
}
async function cancelVerify() {
    return readResult('settings.cancelVerify', await postSettings('settings.cancelVerify', 'result'));
}
async function runAction(name) {
    const route = `settings.action.${name}`;
    return readResult(route, await postSettings(route, 'result'));
}
function asSettingsFailure(error) {
    if (error instanceof SettingsRouteError) {
        return { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) };
    }
    const code = isObject(error) && typeof error.code === 'string' ? error.code : 'unknown';
    return { code, message: error instanceof Error ? error.message : String(error) };
}
			},
			"settings/change.js": function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SETTINGS_ACTIONS = exports.CHANGE_LIMITS = exports.CHANGE_KEYS = void 0;
exports.CHANGE_KEYS = {
    'revoke': ['task_id'], 'revoke_all': [],
    'persistent.remove': ['bundle_id'], 'persistent.add': ['bundle_id', 'mode'],
    'persistent.mode': ['bundle_id', 'mode'], 'persistent.reapprove': ['bundle_id'],
    'deny.add': ['bundle_id', 'note'], 'deny.remove': ['bundle_id'],
    'access.set': ['field', 'value'],
    'chord.disable': ['chord'], 'chord.enable': ['chord'],
    'chord.add': ['chord', 'app', 'note'], 'chord.remove': ['chord', 'app'],
    'privacy.set': ['field', 'on'],
    'text_only.add': ['bundle_id'], 'text_only.remove': ['bundle_id'],
    'clipboard.set': ['on'],
    'behavior.set': ['field', 'value'],
    'logs.retention': ['days'], 'logs.default_directory': [],
    'reset': [],
};
exports.CHANGE_LIMITS = { bundleId: 255, note: 200, chord: 64, taskId: 255 };
exports.SETTINGS_ACTIONS = ['choose_log_directory', 'use_default_log_directory', 'choose_app', 'export_settings',
    'export_audit', 'import', 'import_confirm', 'reveal_log'];
			},
			"settings/locale/access.js": function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.en = exports.zh = void 0;
exports.zh = {
    'settings.access.title': '档位与默认',
    'settings.access.note': '收紧立即生效。放宽（提高档位、延长时效、增加弹窗次数）需 Touch ID 或密码确认。',
    'settings.access.fullPower': '完全放权',
    'settings.access.tier.read.title': '查看、点击、滚动',
    'settings.access.tier.read.item1': '截图、界面结构、读字、放大',
    'settings.access.tier.read.item2': '左键单击、按下按钮（含“发送”）',
    'settings.access.tier.read.item3': '将已运行应用的窗口置于前台',
    'settings.access.tier.read.item4': '不能输入文字或使用快捷键',
    'settings.access.tier.full.title': '在浏览基础上可输入与操作',
    'settings.access.tier.full.item1': '输入文字、设值、允许列表内的快捷键',
    'settings.access.tier.full.item2': '打开应用、⌘Q 退出应用',
    'settings.access.tier.full.item3': '使用应用菜单',
    'settings.access.tier.full.item4': '申请弹窗不提供“始终允许”',
    'settings.access.tier.max.title': '不弹申请窗口，高危操作需确认',
    'settings.access.tier.max.item1': '仅可在「完全放权」页由用户开启',
    'settings.access.tier.max.item2': '模型无法申请此档位',
    'settings.access.tier.max.item3': '有时限，到期自动关闭',
    'settings.access.tier.max.item4': '系统底线仍然拒绝',
    'settings.access.tier.max.note': '尚未提供',
    'settings.access.newSession': '新会话默认',
    'settings.access.defaultMode.title': '默认档位',
    'settings.access.defaultMode.note': '名单外的应用首次被访问时：「每次询问」弹出申请；「浏览」或「可操作」在本次会话内按该档位直接放行，更高的档位仍需申请。',
    'settings.access.defaultMode.lock': '提高需验证 · 完全放权不能设为默认',
    'settings.access.session.title': '「本次会话」最长',
    'settings.access.session.note': '到期或会话结束，以先到者为准；对之后的授权生效。「仅本轮」固定为本轮对话结束。',
    'settings.access.session.lock': '延长需验证',
    'settings.access.dialogs.title': '每轮最多弹窗',
    'settings.access.dialogs.note': '超出后直接拒绝，避免频繁弹窗导致习惯性允许。',
    'settings.access.dialogs.lock': '增加需验证',
    'settings.access.timeout.title': '超时处理',
    'settings.access.timeout.note': '倒计时结束按拒绝处理。',
    'settings.access.defaultButton.title': '默认按钮',
    'settings.access.defaultButton.note': '申请弹窗中回车键按下的按钮。「始终允许」在弹窗不提供它时退为「本次会话」。',
    'settings.access.defaultButton.lock': '拒绝以外需验证',
    'settings.access.noChoices': '守护进程未提供可选值。',
    'settings.access.fixedRules': '固定规则（不能在设置里改）',
    'settings.access.fixedRule1': '模型仅在被拒绝后可附理由申请一次；同一次拒绝只能申请一次。',
    'settings.access.fixedRule2': '本轮已拒绝的应用，本轮不再弹窗；下一条消息起方可重新申请。',
    'settings.access.fixedRule3': '弹窗显示系统解析的应用身份（图标、名称、bundle ID、路径）；模型提供的理由标注为“模型陈述”。',
    'settings.access.fixedRule4': '系统底线中的应用不弹窗，直接拒绝。',
};
exports.en = {
    'settings.access.title': 'Modes and defaults',
    'settings.access.note': 'Tightening takes effect at once. Loosening (a higher mode, a longer session, more dialogs) needs Touch ID or the password.',
    'settings.access.fullPower': 'Full power',
    'settings.access.tier.read.title': 'Look, click, scroll',
    'settings.access.tier.read.item1': 'Screenshots, the UI tree, text, zoom',
    'settings.access.tier.read.item2': 'Left click, press buttons (including “Send”)',
    'settings.access.tier.read.item3': 'Bring a running app\'s window to the front',
    'settings.access.tier.read.item4': 'No typing, no shortcuts',
    'settings.access.tier.full.title': 'Browse, and type and operate',
    'settings.access.tier.full.item1': 'Type, set values, allowlisted shortcuts',
    'settings.access.tier.full.item2': 'Open apps, quit with ⌘Q',
    'settings.access.tier.full.item3': 'Use the app\'s menus',
    'settings.access.tier.full.item4': 'The dialog offers no “always” for it',
    'settings.access.tier.max.title': 'No approval dialogs; risky actions confirmed',
    'settings.access.tier.max.item1': 'Switched on by the user, on its own page only',
    'settings.access.tier.max.item2': 'The model cannot ask for it',
    'settings.access.tier.max.item3': 'Time-limited; ends by itself',
    'settings.access.tier.max.item4': 'The system floor still refuses',
    'settings.access.tier.max.note': 'Not available yet',
    'settings.access.newSession': 'New session default',
    'settings.access.defaultMode.title': 'Default mode',
    'settings.access.defaultMode.note': 'An app outside every list, the first time it is touched: “ask” shows the dialog; “browse” or “operate” grants that mode for the session without one, and a higher mode still asks.',
    'settings.access.defaultMode.lock': 'Raising needs verification · full power is never the default',
    'settings.access.session.title': '“This session” lasts at most',
    'settings.access.session.note': 'Until it expires or the session ends, whichever is first; applies to approvals from now on. “This turn” always ends with the turn.',
    'settings.access.session.lock': 'Lengthening needs verification',
    'settings.access.dialogs.title': 'Dialogs per turn at most',
    'settings.access.dialogs.note': 'Beyond that, refused without asking: a flood of dialogs trains people to click allow.',
    'settings.access.dialogs.lock': 'More needs verification',
    'settings.access.timeout.title': 'Unanswered dialog',
    'settings.access.timeout.note': 'When the countdown ends it counts as a refusal.',
    'settings.access.defaultButton.title': 'Default button',
    'settings.access.defaultButton.note': 'The button Return presses in the approval dialog. “Always” falls back to “this session” when the dialog does not offer it.',
    'settings.access.defaultButton.lock': 'Anything but refuse needs verification',
    'settings.access.noChoices': 'The daemon offers no values for this.',
    'settings.access.fixedRules': 'Fixed rules (not settings)',
    'settings.access.fixedRule1': 'The model may ask once, with a reason, only after a refusal; once per refusal.',
    'settings.access.fixedRule2': 'An app refused this turn is not asked about again this turn; the next message may ask again.',
    'settings.access.fixedRule3': 'The dialog shows the app\'s identity as the system resolves it (icon, name, bundle ID, path); the model\'s reason is marked as its own words.',
    'settings.access.fixedRule4': 'Apps on the system floor are refused without a dialog.',
};
			},
			"settings/locale/apps.js": function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.en = exports.zh = void 0;
exports.zh = {
    'settings.apps.title': '应用名单',
    'settings.apps.note': '三份名单，由宽到严：始终允许、黑名单、系统底线。同一应用出现在多份名单时，按最严格的一份处理。',
    'settings.apps.chooseApp': '选择应用…',
    'settings.apps.waiting': '等待在本机的面板中选择应用…',
    'settings.apps.stopWaiting': '不再等待',
    'settings.apps.always.title': '始终允许',
    'settings.apps.always.note': '按 bundle ID 与应用签名记录；签名变化后授权自动作废。可在此添加，或在申请弹窗中选择「始终允许」，或在终端中添加；加入需 Touch ID 或密码。',
    'settings.apps.always.add': '添加到始终允许…',
    'settings.apps.always.empty': '名单是空的。',
    'settings.apps.always.added': '加入于 {time}',
    'settings.apps.always.signature.ok': '签名匹配',
    'settings.apps.always.signature.changed': '签名已变化 · 已作废',
    'settings.apps.always.signature.unknown': '签名未核对',
    'settings.apps.always.reapprove': '重新批准',
    'settings.apps.always.changeMode': '改档位',
    'settings.apps.always.remove': '移除',
    'settings.apps.always.form.title': '添加到始终允许',
    'settings.apps.always.form.mode': '档位',
    'settings.apps.always.form.note': '加入后，模型在任何会话中都可按所选档位使用该应用，不再弹窗；应用重新签名后自动作废。',
    'settings.apps.always.form.chooseAgain': '重新选择应用…',
    'settings.apps.always.form.submit': '加入',
    'settings.apps.deny.title': '黑名单',
    'settings.apps.deny.note': '模型无法观察或操作这些应用，也不会发出申请。加入立即生效；移出需要身份验证。',
    'settings.apps.deny.add': '添加到黑名单…',
    'settings.apps.deny.empty': '黑名单是空的。',
    'settings.apps.deny.remove': '移出',
    'settings.apps.deny.form.title': '添加到黑名单',
    'settings.apps.deny.form.bundleId': 'Bundle ID',
    'settings.apps.deny.form.bundleIdHint': '输入 bundle ID，或通过「选择应用…」在本机选取；不能包含空格。',
    'settings.apps.deny.form.note': '备注',
    'settings.apps.deny.form.notePlaceholder': '选填',
    'settings.apps.deny.form.submit': '加入',
    'settings.apps.floor.title': '系统底线',
    'settings.apps.floor.note': '内置于守护进程，任何设置均不能修改：永不授权，且它们位于前台时所有动作停止。',
    'settings.apps.floor.count': '{n} 项',
    'settings.apps.floor.empty': '守护进程未列出系统底线。',
    'settings.apps.floor.category.systemUI': '系统界面',
    'settings.apps.floor.category.authentication': '认证与密钥',
    'settings.apps.floor.category.runsCode': '可执行代码',
    'settings.apps.floor.category.selfAndRemote': 'CURuntime 本体与远程控制',
    'settings.apps.floor.category.other': '其他',
};
exports.en = {
    'settings.apps.title': 'App lists',
    'settings.apps.note': 'Three lists, loosest to strictest: always allowed, the deny list, the system floor. An app on several lists gets the strictest.',
    'settings.apps.chooseApp': 'Choose app…',
    'settings.apps.waiting': 'Waiting for an app to be chosen in the panel on this Mac…',
    'settings.apps.stopWaiting': 'Stop waiting',
    'settings.apps.always.title': 'Always allowed',
    'settings.apps.always.note': 'Recorded by bundle ID and code signature; a changed signature voids the entry. Added here, with “Always allow” in the dialog, or in the terminal; adding needs Touch ID or the password.',
    'settings.apps.always.add': 'Add to always allowed…',
    'settings.apps.always.empty': 'The list is empty.',
    'settings.apps.always.added': 'Added {time}',
    'settings.apps.always.signature.ok': 'Signature matches',
    'settings.apps.always.signature.changed': 'Signature changed · void',
    'settings.apps.always.signature.unknown': 'Signature not checked',
    'settings.apps.always.reapprove': 'Approve again',
    'settings.apps.always.changeMode': 'Change mode',
    'settings.apps.always.remove': 'Remove',
    'settings.apps.always.form.title': 'Add to always allowed',
    'settings.apps.always.form.mode': 'Mode',
    'settings.apps.always.form.note': 'Once added, the model may use the app at the chosen mode in every session without a dialog; a re-signed app voids the entry.',
    'settings.apps.always.form.chooseAgain': 'Choose another app…',
    'settings.apps.always.form.submit': 'Add',
    'settings.apps.deny.title': 'Deny list',
    'settings.apps.deny.note': 'The model cannot see, touch or ask about these. Adding takes effect at once; removing needs verification.',
    'settings.apps.deny.add': 'Add to deny list…',
    'settings.apps.deny.empty': 'The deny list is empty.',
    'settings.apps.deny.remove': 'Remove',
    'settings.apps.deny.form.title': 'Add to the deny list',
    'settings.apps.deny.form.bundleId': 'Bundle ID',
    'settings.apps.deny.form.bundleIdHint': 'Type a bundle ID, or pick the app on this Mac with “Choose app…”; no spaces.',
    'settings.apps.deny.form.note': 'Note',
    'settings.apps.deny.form.notePlaceholder': 'Optional',
    'settings.apps.deny.form.submit': 'Add',
    'settings.apps.floor.title': 'System floor',
    'settings.apps.floor.note': 'Compiled into the daemon; no setting changes it: never granted, and every action stops while one is in front.',
    'settings.apps.floor.count': '{n} entries',
    'settings.apps.floor.empty': 'The daemon listed no floor.',
    'settings.apps.floor.category.systemUI': 'System UI',
    'settings.apps.floor.category.authentication': 'Authentication and secrets',
    'settings.apps.floor.category.runsCode': 'Runs code',
    'settings.apps.floor.category.selfAndRemote': 'CURuntime itself and remote control',
    'settings.apps.floor.category.other': 'Other',
};
			},
			"settings/locale/behavior.js": function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.en = exports.zh = void 0;
exports.zh = {
    'settings.behavior.title': '行为与模型',
    'settings.behavior.note': '模型操作本机的方式，以及与用户同时操作时的让行规则。',
    'settings.behavior.unknownValue': '守护进程未给出此项的当前值，暂不能修改。',
    'settings.behavior.operation': '操作',
    'settings.behavior.restoreFocusNote': '回到本轮开始时的前台应用；用户中途切换过则不再改变。',
    'settings.behavior.pointTargetsNote': '关闭后仅可点击已识别的界面元素；纯图像界面中的部分目标将无法点击。',
    'settings.behavior.pointTargetsLock': '关闭立即生效 · 开启需验证',
    'settings.behavior.imePolicyNote': '拼音输入存在未确认候选时，输入的字符会丢失。接管：本轮临时切换到英文键盘，结束后恢复。此处为上限，插件可要求更严格。',
    'settings.behavior.imePolicyLock': '降低立即生效 · 提高需验证',
    'settings.behavior.electronAXNote': 'QQ 等应用需开启此项，界面结构中才包含消息文字。使用后自动恢复。',
    'settings.behavior.electronAXLock': '关闭立即生效 · 开启需验证',
    'settings.behavior.auto': '自动',
    'settings.behavior.off': '关',
    'settings.behavior.advanced': '高级',
    'settings.behavior.activationNote': '仅在激活持续失败时需要更改。',
    'settings.behavior.activationExplicit': '标准（已明确指定）',
    'settings.behavior.importExport': '导入 / 导出设置',
    'settings.behavior.importExportNote': '导入内容若比当前宽松，将逐项列出并需验证。黑名单随设置文件导入导出；始终允许名单不在其中。',
    'settings.behavior.import': '导入…',
    'settings.behavior.export': '导出…',
    'settings.behavior.importTitle': '导入设置',
    'settings.behavior.importChanges': '导入将更改以下 {count} 项：',
    'settings.behavior.importNoChanges': '导入内容与当前设置相同。',
    'settings.behavior.importMore': '仅列出前 {shown} 项，共 {count} 项。',
    'settings.behavior.importLoosens': '导入将放宽以下项，需要身份验证：',
    'settings.behavior.importNothingLoosened': '导入内容不比当前宽松，可直接应用。',
    'settings.behavior.importDirectoryIgnored': '设置文件中的日志存放位置不随导入生效；存放位置只能在「日志」中更改。',
    'settings.behavior.importLeave': '暂不导入',
    'settings.behavior.apply': '应用',
    'settings.behavior.applyVerified': '验证并应用',
    'settings.behavior.reset': '恢复默认设置',
    'settings.behavior.resetNote': '不清空黑名单与仅文本应用，不恢复已停用的快捷键；自定义快捷键将删除。',
    'settings.behavior.resetLock': '放宽当前更严格的设置时需验证',
    'settings.behavior.resetButton': '恢复默认设置…',
    'settings.behavior.resetConfirm': '恢复默认设置',
};
exports.en = {
    'settings.behavior.title': 'Behavior and model',
    'settings.behavior.note': 'How the model operates this Mac, and how it yields when the user is operating too.',
    'settings.behavior.unknownValue': 'The daemon gave no current value for this; it cannot be changed for now.',
    'settings.behavior.operation': 'Operation',
    'settings.behavior.restoreFocusNote': 'Back to the app that was in front when the turn began; left alone if the user switched meanwhile.',
    'settings.behavior.pointTargetsNote': 'Off, only recognised elements can be clicked; some targets in image-only interfaces become unreachable.',
    'settings.behavior.pointTargetsLock': 'Off at once · on again verified',
    'settings.behavior.imePolicyNote': 'With a pending pinyin candidate, typed characters are lost. Take over: switch to the ABC keyboard for the turn and switch back. This is the ceiling; the plugin may ask for less.',
    'settings.behavior.imePolicyLock': 'Lower at once · higher verified',
    'settings.behavior.electronAXNote': 'QQ and the like need it for message text to appear in the UI tree. Restored afterwards.',
    'settings.behavior.electronAXLock': 'Off at once · on again verified',
    'settings.behavior.auto': 'Auto',
    'settings.behavior.off': 'Off',
    'settings.behavior.advanced': 'Advanced',
    'settings.behavior.activationNote': 'Change it only when activation keeps failing.',
    'settings.behavior.activationExplicit': 'Standard (set explicitly)',
    'settings.behavior.importExport': 'Import / export settings',
    'settings.behavior.importExportNote': 'An import that loosens anything lists the items and needs verification. The deny list travels with the file; the always list does not.',
    'settings.behavior.import': 'Import…',
    'settings.behavior.export': 'Export…',
    'settings.behavior.importTitle': 'Import settings',
    'settings.behavior.importChanges': 'The import changes these {count} item(s):',
    'settings.behavior.importNoChanges': 'The import is the same as the current settings.',
    'settings.behavior.importMore': 'The first {shown} of {count} are listed.',
    'settings.behavior.importLoosens': 'The import loosens the following and needs verification:',
    'settings.behavior.importNothingLoosened': 'The import loosens nothing; it can be applied at once.',
    'settings.behavior.importDirectoryIgnored': 'The log location in the file is not imported; it changes only under Logs.',
    'settings.behavior.importLeave': 'Do not import',
    'settings.behavior.apply': 'Apply',
    'settings.behavior.applyVerified': 'Verify and apply',
    'settings.behavior.reset': 'Restore defaults',
    'settings.behavior.resetNote': 'Keeps the deny list, the text-only apps and the switched-off shortcuts; removes the added shortcuts.',
    'settings.behavior.resetLock': 'Verified when it loosens stricter settings',
    'settings.behavior.resetButton': 'Restore defaults…',
    'settings.behavior.resetConfirm': 'Restore defaults',
};
			},
			"settings/locale/index.js": function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.en = exports.zh = exports.LOCALE_FILES = void 0;
const access = require("./access.js");
const apps = require("./apps.js");
const behavior = require("./behavior.js");
const logs = require("./logs.js");
const overview = require("./overview.js");
const privacy = require("./privacy.js");
const shared = require("./shared.js");
const shortcuts = require("./shortcuts.js");
exports.LOCALE_FILES = {
    shared, overview, access, apps, shortcuts, privacy, behavior, logs,
};
const merge = (lang) => Object.assign({}, ...Object.values(exports.LOCALE_FILES).map((file) => file[lang]));
exports.zh = merge('zh');
exports.en = merge('en');
			},
			"settings/locale/logs.js": function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.en = exports.zh = void 0;
exports.zh = {
    'settings.logs.title': '日志',
    'settings.logs.note': '守护进程的审计日志：每个操作的放行与拒绝、授权与撤销、设置变更、启动与停止。按天分文件。',
    'settings.logs.auditLog': '审计日志',
    'settings.logs.location': '存放位置',
    'settings.logs.defaultLocation': '默认位置',
    'settings.logs.customLocation': '自定义位置',
    'settings.logs.defaultTag': '默认',
    'settings.logs.locationNote': '更改后现有日志随之迁移；日志写入所选文件夹下的 cu-runtime-logs 子目录，仅本用户可读。选择文件夹的窗口在本机上打开。',
    'settings.logs.choose': '选择…',
    'settings.logs.useDefault': '恢复默认位置',
    'settings.logs.reveal': '在访达中显示',
    'settings.logs.retention': '保留期限',
    'settings.logs.retentionNote': '按天分文件，含当天在内保留所选天数，更早的自动删除。',
    'settings.logs.retentionLock': '延长立即生效 · 缩短需验证（较早的日志随即删除）',
    'settings.logs.files': '当前文件',
    'settings.logs.fileCount': '{n} 个文件 · {size}',
    'settings.logs.bytes': '{n} 字节',
    'settings.logs.export': '导出最近 7 天',
    'settings.logs.recorded': '记录内容',
    'settings.logs.recordedNote': '放行与拒绝的动作及原因、授权与撤销、设置变更。不记录屏幕内容与模型理由原文（仅记录长度）。',
    'settings.logs.fixed': '固定',
    'settings.logs.recentChanges': '最近设置变更',
    'settings.logs.noChanges': '近 7 天没有设置变更。',
    'settings.logs.verified': '已验证',
    'settings.logs.app': '「{name}」',
    'settings.logs.unknownApp': '未知应用',
    'settings.logs.change.denylistAdd': '黑名单加入{app}',
    'settings.logs.change.denylistRemove': '黑名单移出{app}',
    'settings.logs.change.persistentAdd': '始终允许加入{app}',
    'settings.logs.change.persistentRevoke': '始终允许移除{app}',
    'settings.logs.change.persistentMode': '{app}的始终允许档位已更改',
    'settings.logs.change.persistentReapprove': '重新批准{app}',
    'settings.logs.change.access': '授权规则变更',
    'settings.logs.change.privacy': '隐私设置变更',
    'settings.logs.change.chordDisable': '停用快捷键',
    'settings.logs.change.chordEnable': '启用快捷键',
    'settings.logs.change.chordAdd': '添加快捷键',
    'settings.logs.change.chordAddApp': '添加快捷键（仅{app}）',
    'settings.logs.change.chordRemove': '删除快捷键',
    'settings.logs.change.revoke': '撤销一项授权',
    'settings.logs.change.revokeAll': '撤销全部授权',
    'settings.logs.change.behavior': '行为设置变更',
    'settings.logs.change.import': '导入设置',
    'settings.logs.change.reset': '恢复默认设置',
    'settings.logs.change.auditExport': '导出审计日志',
    'settings.logs.change.logs': '日志设置变更',
    'settings.logs.change.export': '导出设置',
    'settings.logs.change.stop': '停止守护进程',
    'settings.logs.change.restart': '重启守护进程',
};
exports.en = {
    'settings.logs.title': 'Logs',
    'settings.logs.note': 'The daemon\'s audit log: every action allowed or refused, approvals and revocations, settings changes, starts and stops. One file a day.',
    'settings.logs.auditLog': 'Audit log',
    'settings.logs.location': 'Location',
    'settings.logs.defaultLocation': 'Default location',
    'settings.logs.customLocation': 'A chosen folder',
    'settings.logs.defaultTag': 'default',
    'settings.logs.locationNote': 'Changing it moves the existing files; the log is written to a cu-runtime-logs subfolder of the chosen folder, readable by this user only. The folder is chosen in a window on this Mac.',
    'settings.logs.choose': 'Choose…',
    'settings.logs.useDefault': 'Use the default location',
    'settings.logs.reveal': 'Show in Finder',
    'settings.logs.retention': 'Kept for',
    'settings.logs.retentionNote': 'One file a day; the chosen number of days is kept, today included, and older files are deleted.',
    'settings.logs.retentionLock': 'Longer at once · shorter verified (older files are deleted then)',
    'settings.logs.files': 'Files now',
    'settings.logs.fileCount': '{n} file(s) · {size}',
    'settings.logs.bytes': '{n} bytes',
    'settings.logs.export': 'Export the last 7 days',
    'settings.logs.recorded': 'What is recorded',
    'settings.logs.recordedNote': 'Every allowed and refused action with its reason, approvals and revocations, settings changes. Never screen content, never the model\'s reason text (its length only).',
    'settings.logs.fixed': 'Fixed',
    'settings.logs.recentChanges': 'Recent settings changes',
    'settings.logs.noChanges': 'No settings change in the last 7 days.',
    'settings.logs.verified': 'verified',
    'settings.logs.app': '“{name}”',
    'settings.logs.unknownApp': 'an unknown app',
    'settings.logs.change.denylistAdd': 'Deny list: {app} added',
    'settings.logs.change.denylistRemove': 'Deny list: {app} removed',
    'settings.logs.change.persistentAdd': 'Always allowed: {app} added',
    'settings.logs.change.persistentRevoke': 'Always allowed: {app} removed',
    'settings.logs.change.persistentMode': 'Always allowed: {app} mode changed',
    'settings.logs.change.persistentReapprove': '{app} approved again',
    'settings.logs.change.access': 'Access rules changed',
    'settings.logs.change.privacy': 'Privacy settings changed',
    'settings.logs.change.chordDisable': 'A shortcut switched off',
    'settings.logs.change.chordEnable': 'A shortcut switched on',
    'settings.logs.change.chordAdd': 'A shortcut added',
    'settings.logs.change.chordAddApp': 'A shortcut added ({app} only)',
    'settings.logs.change.chordRemove': 'A shortcut removed',
    'settings.logs.change.revoke': 'An approval revoked',
    'settings.logs.change.revokeAll': 'Every approval revoked',
    'settings.logs.change.behavior': 'Behavior settings changed',
    'settings.logs.change.import': 'Settings imported',
    'settings.logs.change.reset': 'Defaults restored',
    'settings.logs.change.auditExport': 'Audit exported',
    'settings.logs.change.logs': 'Log settings changed',
    'settings.logs.change.export': 'Settings exported',
    'settings.logs.change.stop': 'Daemon stopped',
    'settings.logs.change.restart': 'Daemon restarted',
};
			},
			"settings/locale/overview.js": function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.en = exports.zh = void 0;
exports.zh = {
    'settings.overview.title': '概览',
    'settings.overview.note': '系统权限、新会话的默认档位、正在生效的授权与最近拦截记录。',
    'settings.overview.permissions': '系统权限',
    'settings.overview.permission.accessibility': '辅助功能',
    'settings.overview.permission.screen_recording': '屏幕录制',
    'settings.overview.permission.input_monitoring': '输入监控',
    'settings.overview.permission.granted': '已授予',
    'settings.overview.permission.missing': '未授予',
    'settings.overview.permission.notRequested': '未申请',
    'settings.overview.permissionsUnknown': '守护进程未提供权限状态（未在本机图形界面中运行）。',
    'settings.overview.inputMonitoringNote': '当前版本不需要输入监控。',
    'settings.overview.permissionsHint': '权限在「守护进程」标签页中授予：每次打开一个系统设置面板。',
    'settings.overview.newSessionDefault': '新会话默认',
    'settings.overview.newSessionNote': '名单外的应用首次被访问时弹出申请。',
    'settings.overview.newSessionGranted': '名单外的应用首次被访问时，本次会话内直接按「{mode}」放行。',
    'settings.overview.editDefaults': '修改默认档位',
    'settings.overview.activeGrants': '正在生效的授权',
    'settings.overview.noneActive': '现在没有生效的授权。',
    'settings.overview.revokeAll': '全部撤销',
    'settings.overview.revoke': '撤销',
    'settings.overview.configGrant': '配置授权',
    'settings.overview.scope.turn': '仅本轮',
    'settings.overview.scope.always': '始终允许',
    'settings.overview.scope.session': '本次会话',
    'settings.overview.lastsLeft': '{scope} · 剩约 {minutes} 分钟',
    'settings.overview.lastsUnderMinute': '{scope} · 剩不足 1 分钟',
    'settings.overview.byDialog': '弹窗批准',
    'settings.overview.session': '会话 {task}',
    'settings.overview.processGone': '进程已退出',
    'settings.overview.recentRefusals': '最近拦截',
    'settings.overview.refusalsNote': '来源：审计日志，仅记录动作与原因，不含屏幕内容 · 保留最近 100 条。',
    'settings.overview.noRefusals': '近两天没有拦截记录。',
    'settings.overview.yesterday': '昨天 {time}',
    'settings.overview.app': '「{name}」',
    'settings.overview.unknownApp': '未知应用',
    'settings.overview.attempt.access.request': '申请{app}',
    'settings.overview.attempt.apps.launch': '打开{app}',
    'settings.overview.attempt.act.key': '在{app}中按快捷键',
    'settings.overview.attempt.act.type': '向{app}输入',
    'settings.overview.attempt.act.click': '在{app}中点击',
    'settings.overview.attempt.act.menu': '使用{app}菜单',
    'settings.overview.attempt.observe': '查看{app}',
    'settings.overview.attempt.apps.list': '列出应用',
    'settings.overview.attempt.other': '{method} {app}',
    'settings.overview.reason.floor': '系统底线',
    'settings.overview.reason.denyList': '黑名单',
    'settings.overview.reason.dshHost': 'dsh 所在的应用',
    'settings.overview.reason.chord': '快捷键不在允许列表',
    'settings.overview.reason.noGrant': '没有授权',
    'settings.overview.reason.mode': '档位不够',
    'settings.overview.reason.refusedByUser': '用户已拒绝',
    'settings.overview.reason.dialogLimit': '本轮弹窗已到上限',
    'settings.overview.reason.dialogTimeout': '弹窗超时',
    'settings.overview.reason.secureInput': '安全输入（密码框）',
    'settings.overview.reason.outsideWindow': '点在授权窗口外',
    'settings.overview.reason.notOpenable': '文件不可打开',
    'settings.overview.reason.imeSwitch': '输入法切换需确认',
    'settings.overview.reason.finder': '未启用访达',
    'settings.overview.reason.locked': '屏幕已锁定',
};
exports.en = {
    'settings.overview.title': 'Overview',
    'settings.overview.note': 'System permissions, the new session default, approvals in effect and recent refusals.',
    'settings.overview.permissions': 'System permissions',
    'settings.overview.permission.accessibility': 'Accessibility',
    'settings.overview.permission.screen_recording': 'Screen Recording',
    'settings.overview.permission.input_monitoring': 'Input Monitoring',
    'settings.overview.permission.granted': 'Granted',
    'settings.overview.permission.missing': 'Not granted',
    'settings.overview.permission.notRequested': 'Not requested',
    'settings.overview.permissionsUnknown': 'The daemon gave no permission state (it does not run in this Mac\'s graphical session).',
    'settings.overview.inputMonitoringNote': 'This version does not need Input Monitoring.',
    'settings.overview.permissionsHint': 'Permissions are granted on the Daemon tab, one System Settings pane at a time.',
    'settings.overview.newSessionDefault': 'New session default',
    'settings.overview.newSessionNote': 'An app not on a list is asked about the first time it is touched.',
    'settings.overview.newSessionGranted': 'An app not on a list gets “{mode}” for the session the first time it is touched.',
    'settings.overview.editDefaults': 'Change the default mode',
    'settings.overview.activeGrants': 'Approvals in effect',
    'settings.overview.noneActive': 'No approval is in effect now.',
    'settings.overview.revokeAll': 'Revoke all',
    'settings.overview.revoke': 'Revoke',
    'settings.overview.configGrant': 'Config grant',
    'settings.overview.scope.turn': 'This turn',
    'settings.overview.scope.always': 'Always',
    'settings.overview.scope.session': 'This session',
    'settings.overview.lastsLeft': '{scope} · about {minutes} min left',
    'settings.overview.lastsUnderMinute': '{scope} · under 1 min left',
    'settings.overview.byDialog': 'Approved in a dialog',
    'settings.overview.session': 'session {task}',
    'settings.overview.processGone': 'process exited',
    'settings.overview.recentRefusals': 'Recent refusals',
    'settings.overview.refusalsNote': 'From the audit log: actions and reasons only, never screen text · the last 100.',
    'settings.overview.noRefusals': 'Nothing refused in the last two days.',
    'settings.overview.yesterday': 'yest. {time}',
    'settings.overview.app': '“{name}”',
    'settings.overview.unknownApp': 'an app',
    'settings.overview.attempt.access.request': 'Ask for {app}',
    'settings.overview.attempt.apps.launch': 'Open {app}',
    'settings.overview.attempt.act.key': 'Press a shortcut in {app}',
    'settings.overview.attempt.act.type': 'Type into {app}',
    'settings.overview.attempt.act.click': 'Click in {app}',
    'settings.overview.attempt.act.menu': 'Use {app}\'s menu',
    'settings.overview.attempt.observe': 'Look at {app}',
    'settings.overview.attempt.apps.list': 'List apps',
    'settings.overview.attempt.other': '{method} {app}',
    'settings.overview.reason.floor': 'system floor',
    'settings.overview.reason.denyList': 'deny list',
    'settings.overview.reason.dshHost': 'the app dsh runs in',
    'settings.overview.reason.chord': 'chord not on the allowlist',
    'settings.overview.reason.noGrant': 'no approval',
    'settings.overview.reason.mode': 'mode too narrow',
    'settings.overview.reason.refusedByUser': 'refused by the user',
    'settings.overview.reason.dialogLimit': 'dialog limit this turn',
    'settings.overview.reason.dialogTimeout': 'dialog timed out',
    'settings.overview.reason.secureInput': 'secure input (password field)',
    'settings.overview.reason.outsideWindow': 'outside the approved window',
    'settings.overview.reason.notOpenable': 'file not openable',
    'settings.overview.reason.imeSwitch': 'input source switch needs approval',
    'settings.overview.reason.finder': 'Finder not enabled',
    'settings.overview.reason.locked': 'screen locked',
};
			},
			"settings/locale/privacy.js": function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.en = exports.zh = void 0;
exports.zh = {
    'settings.privacy.title': '隐私与审计',
    'settings.privacy.note': '已授权应用窗口的内容将发送至模型服务商（当前为 DeepSeek）。本页配置发送范围与剪贴板；审计记录与保留期限见「日志」标签页。',
    'settings.privacy.sent.title': '发送内容',
    'settings.privacy.sent.lock': '关闭立即生效 · 开启需验证',
    'settings.privacy.send_screenshots.note': '仅包含已授权应用窗口，其余区域遮蔽。关闭后仅发送文本。',
    'settings.privacy.send_ax_text.note': '控件标题、消息内容等。关闭后仅发送控件位置与类型。',
    'settings.privacy.send_ocr.note': '识别在本地完成，仅发送结果。',
    'settings.privacy.send_zoom.note': '模型核对细节时请求的局部高分辨率图像。',
    'settings.privacy.textOnly.title': '仅文本应用',
    'settings.privacy.textOnly.note': '列表内的应用不发送截图。加入立即生效，移除需验证。',
    'settings.privacy.textOnly.add': '添加应用…',
    'settings.privacy.textOnly.empty': '暂无。',
    'settings.privacy.textOnly.remove': '移除',
    'settings.privacy.textOnly.picked': '已在本机选择以下应用，加入后不再发送其截图：',
    'settings.privacy.textOnly.listed': '该应用已在列表中。',
    'settings.privacy.textOnly.addPicked': '加入仅文本应用',
    'settings.privacy.textOnly.dismiss': '不加入',
    'settings.privacy.clipboard.title': '剪贴板',
    'settings.privacy.clipboard.label': '每轮开始时清空剪贴板',
    'settings.privacy.clipboard.note': '避免模型粘贴用户此前复制的内容。',
};
exports.en = {
    'settings.privacy.title': 'Privacy and audit',
    'settings.privacy.note': 'What is inside an approved app\'s windows goes to the model\'s provider (DeepSeek now). This tab sets what is sent and the clipboard; the audit records and how long they are kept are on the Logs tab.',
    'settings.privacy.sent.title': 'Sent content',
    'settings.privacy.sent.lock': 'Off at once · on again verified',
    'settings.privacy.send_screenshots.note': 'Only approved apps\' windows; the rest is grey. Off, the model gets text only.',
    'settings.privacy.send_ax_text.note': 'Button titles, message text and the like. Off, the tree carries positions and roles only.',
    'settings.privacy.send_ocr.note': 'Recognised here; only the result is sent.',
    'settings.privacy.send_zoom.note': 'The close-ups the model asks for to read small text or an emoji.',
    'settings.privacy.textOnly.title': 'Text-only apps',
    'settings.privacy.textOnly.note': 'Even approved, no screenshot of these leaves this Mac. Adding is at once; removing verified.',
    'settings.privacy.textOnly.add': 'Add app…',
    'settings.privacy.textOnly.empty': 'None.',
    'settings.privacy.textOnly.remove': 'Remove',
    'settings.privacy.textOnly.picked': 'Picked on this Mac; once added, no screenshot of it is sent:',
    'settings.privacy.textOnly.listed': 'This app is on the list already.',
    'settings.privacy.textOnly.addPicked': 'Add to text-only apps',
    'settings.privacy.textOnly.dismiss': 'Do not add',
    'settings.privacy.clipboard.title': 'Clipboard',
    'settings.privacy.clipboard.label': 'Empty the clipboard when a turn starts',
    'settings.privacy.clipboard.note': 'So the model cannot paste what was copied before with ⌘V.',
};
			},
			"settings/locale/shared.js": function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.en = exports.zh = void 0;
exports.zh = {
    'settings.tabs.label': 'CURuntime 插件页面',
    'settings.tab.daemon': '守护进程',
    'settings.tab.overview': '概览',
    'settings.tab.access': '档位与默认',
    'settings.tab.apps': '应用名单',
    'settings.tab.shortcuts': '快捷键',
    'settings.tab.privacy': '隐私与审计',
    'settings.tab.behavior': '行为与模型',
    'settings.tab.logs': '日志',
    'settings.loading': '正在读取守护进程的设置…',
    'settings.pending.title': '等待本机验证：{summary}',
    'settings.pending.verify': '请在本机完成 Touch ID 或输入登录密码。',
    'settings.pending.locked': '验证完成或取消之前，各标签页的更改操作暂不可用。',
    'settings.pending.cancel': '取消',
    'settings.notice.dismiss': '知道了',
    'settings.toDaemon': '前往「守护进程」标签页',
    'settings.close': '关闭',
    'settings.confirm': '确定',
    'settings.cancel': '取消',
    'settings.listSeparator': '、',
    'settings.app.unknown': '未知应用',
    'settings.app.id': '「{id}」',
    'settings.app.named': '「{name}」（{id}）',
    'settings.app.everyApproved': '所有已授权应用',
    'settings.mode.read': '浏览',
    'settings.mode.full': '可操作',
    'settings.value.on': '开',
    'settings.value.off': '关',
    'settings.value.none': '—',
    'settings.value.default_mode.ask': '每次询问',
    'settings.value.default_mode.read': '浏览',
    'settings.value.default_mode.full': '可操作',
    'settings.value.dialog_default.deny': '拒绝',
    'settings.value.dialog_default.turn': '仅本轮',
    'settings.value.dialog_default.session': '本次会话',
    'settings.value.dialog_default.always': '始终允许',
    'settings.value.ime_policy_cap.leave': '不切换',
    'settings.value.ime_policy_cap.ask': '每次询问',
    'settings.value.ime_policy_cap.takeover': '本轮接管',
    'settings.value.activation_method.default': '标准（推荐）',
    'settings.value.activation_method.running_application': '标准（推荐）',
    'settings.value.activation_method.ax_frontmost': '无障碍前台属性',
    'settings.value.activation_method.ax_raise': '无障碍窗口前置',
    'settings.unit.minutes': '{n} 分钟',
    'settings.unit.times': '{n} 次',
    'settings.unit.seconds': '{n} 秒',
    'settings.unit.days': '{n} 天',
    'settings.field.access.default_mode': '默认档位',
    'settings.field.access.session_limit_minutes': '「本次会话」最长',
    'settings.field.access.dialogs_per_turn': '每轮最多弹窗',
    'settings.field.access.dialog_timeout_seconds': '弹窗超时',
    'settings.field.access.dialog_default': '弹窗默认按钮',
    'settings.field.privacy.send_screenshots': '截图',
    'settings.field.privacy.send_ax_text': '界面文本',
    'settings.field.privacy.send_ocr': '本地识别文本（OCR）',
    'settings.field.privacy.send_zoom': '局部放大图',
    'settings.field.behavior.restore_focus_on_turn_end': '每轮结束后归还焦点',
    'settings.field.behavior.allow_point_targets': '允许按坐标点击',
    'settings.field.behavior.ime_policy_cap': '中文输入法处理',
    'settings.field.behavior.electron_ax_auto': 'Electron 应用的无障碍开关',
    'settings.field.behavior.activation_method': '激活应用的方式',
    'settings.summary.revoke': '撤销会话 {task} 的授权',
    'settings.summary.revoke_all': '撤销全部授权',
    'settings.summary.persistent.remove': '将{app}移出始终允许名单',
    'settings.summary.persistent.add': '将{app}以「{mode}」加入始终允许名单',
    'settings.summary.persistent.mode': '将始终允许名单中{app}的档位改为「{mode}」',
    'settings.summary.persistent.reapprove': '重新批准始终允许名单中的{app}',
    'settings.summary.deny.add': '将{app}加入黑名单',
    'settings.summary.deny.remove': '将{app}移出黑名单',
    'settings.summary.access.set': '将「{field}」改为{value}',
    'settings.summary.chord.disable': '停用快捷键 {chord}',
    'settings.summary.chord.enable': '恢复快捷键 {chord}',
    'settings.summary.chord.add': '允许在{app}中使用快捷键 {chord}',
    'settings.summary.chord.remove': '删除{app}的快捷键 {chord}',
    'settings.summary.privacy.on': '恢复发送「{field}」',
    'settings.summary.privacy.off': '停止发送「{field}」',
    'settings.summary.text_only.add': '将{app}加入仅文本应用',
    'settings.summary.text_only.remove': '将{app}移出仅文本应用',
    'settings.summary.clipboard.on': '每轮开始时清空剪贴板',
    'settings.summary.clipboard.off': '每轮开始时不再清空剪贴板',
    'settings.summary.behavior.set': '将「{field}」改为{value}',
    'settings.summary.logs.retention': '将审计日志保留期限改为{days}',
    'settings.summary.logs.default_directory': '将日志移回默认文件夹',
    'settings.summary.logs.directory': '将日志移到 {directory}',
    'settings.summary.reset': '恢复默认设置（放宽：{loosened}）',
    'settings.summary.import': '应用导入的设置（放宽：{loosened}）',
    'settings.summary.other': '一项设置更改（{kind}）',
    'settings.what.revoke': '撤销授权',
    'settings.what.revoke_all': '撤销全部授权',
    'settings.what.persistent.remove': '移出始终允许名单',
    'settings.what.persistent.add': '加入始终允许名单',
    'settings.what.persistent.mode': '更改始终允许名单中的档位',
    'settings.what.persistent.reapprove': '重新批准',
    'settings.what.deny.add': '加入黑名单',
    'settings.what.deny.remove': '移出黑名单',
    'settings.what.access.set': '档位与默认的更改',
    'settings.what.chord.disable': '停用快捷键',
    'settings.what.chord.enable': '恢复快捷键',
    'settings.what.chord.add': '添加快捷键',
    'settings.what.chord.remove': '删除快捷键',
    'settings.what.privacy.set': '发送内容的更改',
    'settings.what.text_only.add': '加入仅文本应用',
    'settings.what.text_only.remove': '移出仅文本应用',
    'settings.what.clipboard.set': '剪贴板设置的更改',
    'settings.what.behavior.set': '行为设置的更改',
    'settings.what.logs.retention': '保留期限的更改',
    'settings.what.logs.default_directory': '使用默认日志文件夹',
    'settings.what.logs.directory': '更改日志文件夹',
    'settings.what.reset': '恢复默认设置',
    'settings.what.import': '导入设置',
    'settings.what.choose_log_directory': '选择日志文件夹',
    'settings.what.use_default_log_directory': '使用默认日志文件夹',
    'settings.what.choose_app': '选择应用',
    'settings.what.export_settings': '导出设置',
    'settings.what.export_audit': '导出审计日志',
    'settings.what.import_confirm': '应用导入的设置',
    'settings.what.reveal_log': '在访达中显示日志',
    'settings.what.other': '操作「{kind}」',
    'settings.outcome.applied': '{what}：已生效。',
    'settings.outcome.done': '{what}：已完成。',
    'settings.outcome.verify_failed': '{what}：没有通过验证，没有改动。',
    'settings.outcome.verify_cancelled': '{what}：验证已取消，没有改动。',
    'settings.outcome.verify_unavailable': '{what}：本机当前无法进行身份验证，没有改动。',
    'settings.outcome.cancelled': '{what}：已取消，没有改动。',
    'settings.outcome.refused': '{what}：未完成。{reason}',
    'settings.outcome.other': '{what}：{outcome}。',
    'settings.reasonCode': '原因：{reason}。',
    'settings.result.open': '{what}：已在本机打开面板，请在本机屏幕上完成。',
    'settings.result.busy': '本机已有一个面板（{panel}）正在打开，请先完成或关闭它。此次操作未执行。',
    'settings.result.applied': '{what}：已生效。',
    'settings.result.done': '{what}：已完成。',
    'settings.error.bad_request': '宿主服务拒绝了此次更改的格式，没有改动；插件页面可能与宿主服务版本不一致。',
    'settings.error.busy': '安装任务正在停止、替换或启动守护进程，设置暂不可用；任务结束后自动恢复。',
    'settings.error.not_running': '守护进程未运行，或运行的不是已安装且通过校验的正式版本。请在「守护进程」标签页中启动或重新安装。',
    'settings.error.internal': '宿主服务发生内部错误。',
    'settings.error.daemon_error': '守护进程未能完成此次请求。',
    'settings.error.verification_required': '此项更改属于放宽操作，需要在本机完成身份验证，没有改动。',
    'settings.error.verify_busy': '已有一项验证正在进行，请先完成或取消。此次更改未生效。',
    'settings.error.verify_cooldown': '验证失败次数过多，请在 {seconds} 秒后重试。此次更改未生效。',
    'settings.error.verify_cooldownUntimed': '验证失败次数过多，请稍后重试。此次更改未生效。',
    'settings.error.verify_unavailable': '本机当前无法进行身份验证，放宽类更改无法完成。',
    'settings.error.verify_failed': '没有通过验证，没有改动。',
    'settings.error.verify_cancelled': '验证已取消，没有改动。',
    'settings.error.approval_open': '申请弹窗正在显示，请先处理弹窗再重试。',
    'settings.error.settings_unavailable': '守护进程当前无法在本机打开面板。',
    'settings.error.nothing_pending': '当前没有等待验证或待应用的更改。',
    'settings.error.settings_changed': '设置在此期间已被修改，此次更改未应用。请核对当前设置后重新操作。',
    'settings.error.not_found': '要修改的项目已不存在。',
    'settings.error.app_not_grantable': '该应用不能被授权。',
    'settings.error.app_not_found': '本机找不到该应用。',
    'settings.error.hard_denied': '该应用属于系统底线，任何设置都不能授权。',
    'settings.error.user_denied': '该应用在黑名单中，需先将其移出黑名单。',
    'settings.error.invalid_chord': '无法识别该快捷键的写法。',
    'settings.error.chord_never_allowed': '该快捷键属于系统保留组合，始终不允许。',
    'settings.error.chord_builtin': '该快捷键是内置项，只能停用或恢复，不能添加或删除。',
    'settings.error.log_directory_missing': '日志文件夹不存在。',
    'settings.error.invalid_params': '守护进程拒绝了此次更改的内容，没有改动；插件页面可能与守护进程版本不一致。',
    'settings.error.unauthorized': '登录已失效，请刷新页面后重试。',
    'settings.error.network': '无法连接 dsh。',
    'settings.error.bad_response': 'dsh 的回答格式不符，插件页面可能与宿主服务版本不一致。',
    'settings.error.unknown': '操作失败（{code}）。',
    'settings.error.detail': '详情：{message}',
};
exports.en = {
    'settings.tabs.label': 'CURuntime plugin page',
    'settings.tab.daemon': 'Daemon',
    'settings.tab.overview': 'Overview',
    'settings.tab.access': 'Modes and defaults',
    'settings.tab.apps': 'App lists',
    'settings.tab.shortcuts': 'Shortcuts',
    'settings.tab.privacy': 'Privacy and audit',
    'settings.tab.behavior': 'Behavior and model',
    'settings.tab.logs': 'Logs',
    'settings.loading': 'Reading the daemon\'s settings…',
    'settings.pending.title': 'Waiting for verification on this Mac: {summary}',
    'settings.pending.verify': 'Use Touch ID or enter the login password on this Mac.',
    'settings.pending.locked': 'Until it is verified or cancelled, no tab makes changes.',
    'settings.pending.cancel': 'Cancel',
    'settings.notice.dismiss': 'OK',
    'settings.toDaemon': 'Go to the Daemon tab',
    'settings.close': 'Close',
    'settings.confirm': 'OK',
    'settings.cancel': 'Cancel',
    'settings.listSeparator': ', ',
    'settings.app.unknown': 'an unknown app',
    'settings.app.id': '“{id}”',
    'settings.app.named': '“{name}” ({id})',
    'settings.app.everyApproved': 'every approved app',
    'settings.mode.read': 'Browse',
    'settings.mode.full': 'Operate',
    'settings.value.on': 'on',
    'settings.value.off': 'off',
    'settings.value.none': '—',
    'settings.value.default_mode.ask': 'Ask every time',
    'settings.value.default_mode.read': 'Browse',
    'settings.value.default_mode.full': 'Operate',
    'settings.value.dialog_default.deny': 'Refuse',
    'settings.value.dialog_default.turn': 'This turn',
    'settings.value.dialog_default.session': 'This session',
    'settings.value.dialog_default.always': 'Always',
    'settings.value.ime_policy_cap.leave': 'Leave',
    'settings.value.ime_policy_cap.ask': 'Ask',
    'settings.value.ime_policy_cap.takeover': 'Take over',
    'settings.value.activation_method.default': 'Standard (recommended)',
    'settings.value.activation_method.running_application': 'Standard (recommended)',
    'settings.value.activation_method.ax_frontmost': 'Accessibility frontmost attribute',
    'settings.value.activation_method.ax_raise': 'Accessibility window raise',
    'settings.unit.minutes': '{n} min',
    'settings.unit.times': '{n}',
    'settings.unit.seconds': '{n} s',
    'settings.unit.days': '{n} days',
    'settings.field.access.default_mode': 'Default mode',
    'settings.field.access.session_limit_minutes': '“This session” lasts at most',
    'settings.field.access.dialogs_per_turn': 'Dialogs per turn at most',
    'settings.field.access.dialog_timeout_seconds': 'Dialog timeout',
    'settings.field.access.dialog_default': 'Dialog default button',
    'settings.field.privacy.send_screenshots': 'Screenshots',
    'settings.field.privacy.send_ax_text': 'UI text',
    'settings.field.privacy.send_ocr': 'Locally recognised text (OCR)',
    'settings.field.privacy.send_zoom': 'Zoomed images',
    'settings.field.behavior.restore_focus_on_turn_end': 'Return the focus when a turn ends',
    'settings.field.behavior.allow_point_targets': 'Allow coordinate targets',
    'settings.field.behavior.ime_policy_cap': 'Input source handling',
    'settings.field.behavior.electron_ax_auto': 'Accessibility switch for Electron apps',
    'settings.field.behavior.activation_method': 'How apps are activated',
    'settings.summary.revoke': 'Revoke the approvals of session {task}',
    'settings.summary.revoke_all': 'Revoke every approval',
    'settings.summary.persistent.remove': 'Remove {app} from the always list',
    'settings.summary.persistent.add': 'Add {app} to the always list as “{mode}”',
    'settings.summary.persistent.mode': 'Set {app} on the always list to “{mode}”',
    'settings.summary.persistent.reapprove': 'Approve {app} on the always list again',
    'settings.summary.deny.add': 'Add {app} to the deny list',
    'settings.summary.deny.remove': 'Remove {app} from the deny list',
    'settings.summary.access.set': 'Set “{field}” to {value}',
    'settings.summary.chord.disable': 'Switch off the shortcut {chord}',
    'settings.summary.chord.enable': 'Switch the shortcut {chord} back on',
    'settings.summary.chord.add': 'Allow the shortcut {chord} in {app}',
    'settings.summary.chord.remove': 'Remove the shortcut {chord} of {app}',
    'settings.summary.privacy.on': 'Send “{field}” again',
    'settings.summary.privacy.off': 'Stop sending “{field}”',
    'settings.summary.text_only.add': 'Add {app} to the text-only apps',
    'settings.summary.text_only.remove': 'Remove {app} from the text-only apps',
    'settings.summary.clipboard.on': 'Empty the clipboard when a turn starts',
    'settings.summary.clipboard.off': 'Stop emptying the clipboard when a turn starts',
    'settings.summary.behavior.set': 'Set “{field}” to {value}',
    'settings.summary.logs.retention': 'Keep the audit log for {days}',
    'settings.summary.logs.default_directory': 'Move the log back to the default folder',
    'settings.summary.logs.directory': 'Move the log to {directory}',
    'settings.summary.reset': 'Restore the defaults (loosens: {loosened})',
    'settings.summary.import': 'Apply the imported settings (loosens: {loosened})',
    'settings.summary.other': 'A settings change ({kind})',
    'settings.what.revoke': 'Revoking an approval',
    'settings.what.revoke_all': 'Revoking every approval',
    'settings.what.persistent.remove': 'Removing from the always list',
    'settings.what.persistent.add': 'Adding to the always list',
    'settings.what.persistent.mode': 'Changing a mode on the always list',
    'settings.what.persistent.reapprove': 'Approving again',
    'settings.what.deny.add': 'Adding to the deny list',
    'settings.what.deny.remove': 'Removing from the deny list',
    'settings.what.access.set': 'The modes and defaults change',
    'settings.what.chord.disable': 'Switching off a shortcut',
    'settings.what.chord.enable': 'Switching a shortcut back on',
    'settings.what.chord.add': 'Adding a shortcut',
    'settings.what.chord.remove': 'Removing a shortcut',
    'settings.what.privacy.set': 'The sent-content change',
    'settings.what.text_only.add': 'Adding a text-only app',
    'settings.what.text_only.remove': 'Removing a text-only app',
    'settings.what.clipboard.set': 'The clipboard change',
    'settings.what.behavior.set': 'The behavior change',
    'settings.what.logs.retention': 'The retention change',
    'settings.what.logs.default_directory': 'Using the default log folder',
    'settings.what.logs.directory': 'Changing the log folder',
    'settings.what.reset': 'Restoring the defaults',
    'settings.what.import': 'Importing settings',
    'settings.what.choose_log_directory': 'Choosing the log folder',
    'settings.what.use_default_log_directory': 'Using the default log folder',
    'settings.what.choose_app': 'Choosing an app',
    'settings.what.export_settings': 'Exporting the settings',
    'settings.what.export_audit': 'Exporting the audit log',
    'settings.what.import_confirm': 'Applying the imported settings',
    'settings.what.reveal_log': 'Showing the log in the Finder',
    'settings.what.other': 'The operation “{kind}”',
    'settings.outcome.applied': '{what}: in effect.',
    'settings.outcome.done': '{what}: done.',
    'settings.outcome.verify_failed': '{what}: not verified; nothing changed.',
    'settings.outcome.verify_cancelled': '{what}: verification cancelled; nothing changed.',
    'settings.outcome.verify_unavailable': '{what}: this Mac cannot verify the owner now; nothing changed.',
    'settings.outcome.cancelled': '{what}: cancelled; nothing changed.',
    'settings.outcome.refused': '{what}: not done. {reason}',
    'settings.outcome.other': '{what}: {outcome}.',
    'settings.reasonCode': 'Reason: {reason}.',
    'settings.result.open': '{what}: a panel is open on this Mac; finish there.',
    'settings.result.busy': 'A panel ({panel}) is already open on this Mac; finish or close it first. Nothing was done.',
    'settings.result.applied': '{what}: in effect.',
    'settings.result.done': '{what}: done.',
    'settings.error.bad_request': 'The host service refused the shape of this change; nothing changed. The plugin page and the '
        + 'host service may be from different versions.',
    'settings.error.busy': 'An install task is stopping, replacing or starting the daemon; the settings are back once it ends.',
    'settings.error.not_running': 'The daemon is not running, or what runs is not the installed and verified release build. '
        + 'Start or reinstall it on the Daemon tab.',
    'settings.error.internal': 'The host service ran into an internal error.',
    'settings.error.daemon_error': 'The daemon could not complete the request.',
    'settings.error.verification_required': 'This change loosens the settings and needs the owner verified on this Mac; nothing changed.',
    'settings.error.verify_busy': 'A verification is already open; finish or cancel it first. This change was not made.',
    'settings.error.verify_cooldown': 'Too many failed verifications; try again in {seconds} s. This change was not made.',
    'settings.error.verify_cooldownUntimed': 'Too many failed verifications; try again later. This change was not made.',
    'settings.error.verify_unavailable': 'This Mac cannot verify the owner now, so a loosening change cannot be made.',
    'settings.error.verify_failed': 'Not verified; nothing changed.',
    'settings.error.verify_cancelled': 'Verification cancelled; nothing changed.',
    'settings.error.approval_open': 'An approval dialog is showing; answer it first, then try again.',
    'settings.error.settings_unavailable': 'The daemon cannot open a panel on this Mac now.',
    'settings.error.nothing_pending': 'No change is waiting for verification or to be applied.',
    'settings.error.settings_changed': 'The settings changed in the meantime, so the change was not applied. Check the current '
        + 'settings and make it again.',
    'settings.error.not_found': 'The item to change no longer exists.',
    'settings.error.app_not_grantable': 'This app cannot be approved.',
    'settings.error.app_not_found': 'The app is not on this Mac.',
    'settings.error.hard_denied': 'The app is on the system floor; no setting can approve it.',
    'settings.error.user_denied': 'The app is on the deny list; remove it from there first.',
    'settings.error.invalid_chord': 'The shortcut is not written in a form the daemon reads.',
    'settings.error.chord_never_allowed': 'The shortcut is a combination the system reserves; it is never allowed.',
    'settings.error.chord_builtin': 'The shortcut is built in: it can be switched off or on, not added or removed.',
    'settings.error.log_directory_missing': 'The log folder does not exist.',
    'settings.error.invalid_params': 'The daemon refused the content of this change; nothing changed. The plugin page and the '
        + 'daemon may be from different versions.',
    'settings.error.unauthorized': 'The sign-in is no longer valid; reload the page and try again.',
    'settings.error.network': 'dsh could not be reached.',
    'settings.error.bad_response': 'dsh answered in an unexpected shape; the plugin page and the host service may be from '
        + 'different versions.',
    'settings.error.unknown': 'The operation failed ({code}).',
    'settings.error.detail': 'Details: {message}',
};
			},
			"settings/locale/shortcuts.js": function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.en = exports.zh = void 0;
exports.zh = {
    'settings.shortcuts.title': '快捷键',
    'settings.shortcuts.note': '仅可操作档可以使用快捷键。不带修饰键或仅带 ⇧ 的按键（字母、回车、Tab、方向键等）始终可用；带 ⌘ ⌃ ⌥ 的组合仅放行下列项。',
    'settings.shortcuts.builtin.title': '内置允许',
    'settings.shortcuts.builtin.note': '编辑与光标移动的常用组合，只能停用或恢复，不能删除。停用立即生效；恢复需 Touch ID 或密码。',
    'settings.shortcuts.builtin.off': '已停用',
    'settings.shortcuts.builtin.empty': '守护进程未列出内置快捷键。',
    'settings.shortcuts.custom.title': '自定义',
    'settings.shortcuts.custom.note': '可限定仅在指定应用内生效。添加需验证，删除立即生效。',
    'settings.shortcuts.custom.empty': '还没有自定义快捷键。',
    'settings.shortcuts.custom.add': '添加快捷键…',
    'settings.shortcuts.custom.everyApp': '所有已授权应用',
    'settings.shortcuts.custom.onlyIn': '仅 {app}',
    'settings.shortcuts.custom.remove': '移除',
    'settings.shortcuts.form.title': '添加快捷键',
    'settings.shortcuts.form.combo': '组合键',
    'settings.shortcuts.form.comboHint': '按 cmd+shift+k 的写法输入：修饰键（cmd、ctrl、opt、shift）在前，按键在后，以 + 连接。系统保留的组合无法添加。',
    'settings.shortcuts.form.scope': '在哪里生效',
    'settings.shortcuts.form.everyApp': '所有已授权应用',
    'settings.shortcuts.form.oneApp': '仅一个应用',
    'settings.shortcuts.form.bundleId': 'Bundle ID',
    'settings.shortcuts.form.chooseApp': '选择应用…',
    'settings.shortcuts.form.waiting': '等待在本机的面板中选择应用…',
    'settings.shortcuts.form.stopWaiting': '不再等待',
    'settings.shortcuts.form.note': '说明',
    'settings.shortcuts.form.notePlaceholder': '例如：加粗',
    'settings.shortcuts.form.submit': '加入',
    'settings.shortcuts.never.title': '永不允许',
    'settings.shortcuts.never.note': '影响整机或其他应用的组合。不可添加；完全放权下同样拒绝。',
    'settings.shortcuts.never.fKeys': 'F1–F12 功能键',
    'settings.shortcuts.never.fnCombos': 'fn 组合键',
    'settings.shortcuts.never.empty': '守护进程未列出永不允许的组合。',
    'settings.shortcuts.label.cmd+a': '全选',
    'settings.shortcuts.label.cmd+c': '拷贝',
    'settings.shortcuts.label.cmd+v': '粘贴',
    'settings.shortcuts.label.cmd+x': '剪切',
    'settings.shortcuts.label.cmd+z': '撤销',
    'settings.shortcuts.label.shift+cmd+z': '重做',
    'settings.shortcuts.label.cmd+f': '查找',
    'settings.shortcuts.label.cmd+g': '查找下一个',
    'settings.shortcuts.label.cmd+w': '关闭窗口',
    'settings.shortcuts.label.cmd+n': '新建',
    'settings.shortcuts.label.cmd+s': '存储',
    'settings.shortcuts.label.cmd+q': '退出应用',
    'settings.shortcuts.label.cmd+delete': '删到行首',
    'settings.shortcuts.label.cmd+l': '地址栏',
    'settings.shortcuts.label.shift+cmd+t': '恢复标签 / 纯文本',
    'settings.shortcuts.label.cmd+b': '粗体',
    'settings.shortcuts.label.cmd+i': '斜体',
    'settings.shortcuts.label.cmd+u': '下划线',
    'settings.shortcuts.label.shift+cmd+left': '选到行首',
    'settings.shortcuts.label.shift+cmd+right': '选到行尾',
    'settings.shortcuts.label.shift+cmd+up': '选到文首',
    'settings.shortcuts.label.shift+cmd+down': '选到文末',
    'settings.shortcuts.label.opt+shift+left': '按词选择',
    'settings.shortcuts.label.opt+shift+right': '按词选择',
    'settings.shortcuts.label.opt+left': '按词移动',
    'settings.shortcuts.label.opt+right': '按词移动',
    'settings.shortcuts.label.opt+up': '按段移动',
    'settings.shortcuts.label.opt+down': '按段移动',
    'settings.shortcuts.label.cmd+left': '行首',
    'settings.shortcuts.label.cmd+right': '行尾',
    'settings.shortcuts.label.cmd+up': '文首',
    'settings.shortcuts.label.cmd+down': '文末',
    'settings.shortcuts.label.ctrl+cmd+q': '锁屏',
    'settings.shortcuts.label.shift+cmd+q': '注销',
    'settings.shortcuts.label.opt+cmd+escape': '强制退出',
    'settings.shortcuts.label.cmd+space': '聚焦',
    'settings.shortcuts.label.ctrl+space': '切换输入法',
    'settings.shortcuts.label.cmd+tab': '切换应用',
    'settings.shortcuts.label.opt+cmd+h': '隐藏其他',
    'settings.shortcuts.label.shift+cmd+3': '截屏',
    'settings.shortcuts.label.shift+cmd+4': '截屏',
    'settings.shortcuts.label.shift+cmd+5': '截屏',
    'settings.shortcuts.label.ctrl+up': '调度中心',
    'settings.shortcuts.label.ctrl+down': '应用窗口',
    'settings.shortcuts.label.ctrl+left': '切换空间',
    'settings.shortcuts.label.ctrl+right': '切换空间',
    'settings.shortcuts.label.opt+cmd+d': '隐藏程序坞',
    'settings.shortcuts.label.ctrl+f2': '焦点到菜单栏',
};
exports.en = {
    'settings.shortcuts.title': 'Shortcuts',
    'settings.shortcuts.note': 'Only the operate mode may press shortcuts. Keys without a modifier or with ⇧ alone (letters, Return, Tab, arrows…) are always allowed; combinations with ⌘ ⌃ ⌥ only when listed below.',
    'settings.shortcuts.builtin.title': 'Built in',
    'settings.shortcuts.builtin.note': 'Common editing and cursor combinations. They can be switched off or on, not removed; off at once, on again with Touch ID or the password.',
    'settings.shortcuts.builtin.off': 'off',
    'settings.shortcuts.builtin.empty': 'The daemon listed no built-in shortcut.',
    'settings.shortcuts.custom.title': 'Added by the user',
    'settings.shortcuts.custom.note': 'May be limited to one app. Adding is verified; removing takes effect at once.',
    'settings.shortcuts.custom.empty': 'No shortcut has been added.',
    'settings.shortcuts.custom.add': 'Add a shortcut…',
    'settings.shortcuts.custom.everyApp': 'Every approved app',
    'settings.shortcuts.custom.onlyIn': '{app} only',
    'settings.shortcuts.custom.remove': 'Remove',
    'settings.shortcuts.form.title': 'Add a shortcut',
    'settings.shortcuts.form.combo': 'Combination',
    'settings.shortcuts.form.comboHint': 'Type it as cmd+shift+k: the modifiers (cmd, ctrl, opt, shift) first, then the key, joined with +. Combinations the system reserves cannot be added.',
    'settings.shortcuts.form.scope': 'Where it applies',
    'settings.shortcuts.form.everyApp': 'Every approved app',
    'settings.shortcuts.form.oneApp': 'One app',
    'settings.shortcuts.form.bundleId': 'Bundle ID',
    'settings.shortcuts.form.chooseApp': 'Choose app…',
    'settings.shortcuts.form.waiting': 'Waiting for an app to be chosen in the panel on this Mac…',
    'settings.shortcuts.form.stopWaiting': 'Stop waiting',
    'settings.shortcuts.form.note': 'Note',
    'settings.shortcuts.form.notePlaceholder': 'e.g. bold',
    'settings.shortcuts.form.submit': 'Add',
    'settings.shortcuts.never.title': 'Never allowed',
    'settings.shortcuts.never.note': 'Combinations that reach the whole machine or other apps. Cannot be added; refused under full power too.',
    'settings.shortcuts.never.fKeys': 'F1–F12',
    'settings.shortcuts.never.fnCombos': 'fn combinations',
    'settings.shortcuts.never.empty': 'The daemon listed no never-allowed combination.',
    'settings.shortcuts.label.cmd+a': 'select all',
    'settings.shortcuts.label.cmd+c': 'copy',
    'settings.shortcuts.label.cmd+v': 'paste',
    'settings.shortcuts.label.cmd+x': 'cut',
    'settings.shortcuts.label.cmd+z': 'undo',
    'settings.shortcuts.label.shift+cmd+z': 'redo',
    'settings.shortcuts.label.cmd+f': 'find',
    'settings.shortcuts.label.cmd+g': 'find next',
    'settings.shortcuts.label.cmd+w': 'close window',
    'settings.shortcuts.label.cmd+n': 'new',
    'settings.shortcuts.label.cmd+s': 'save',
    'settings.shortcuts.label.cmd+q': 'quit',
    'settings.shortcuts.label.cmd+delete': 'delete to line start',
    'settings.shortcuts.label.cmd+l': 'address bar',
    'settings.shortcuts.label.shift+cmd+t': 'reopen tab / plain text',
    'settings.shortcuts.label.cmd+b': 'bold',
    'settings.shortcuts.label.cmd+i': 'italic',
    'settings.shortcuts.label.cmd+u': 'underline',
    'settings.shortcuts.label.shift+cmd+left': 'select to line start',
    'settings.shortcuts.label.shift+cmd+right': 'select to line end',
    'settings.shortcuts.label.shift+cmd+up': 'select to start',
    'settings.shortcuts.label.shift+cmd+down': 'select to end',
    'settings.shortcuts.label.opt+shift+left': 'select by word',
    'settings.shortcuts.label.opt+shift+right': 'select by word',
    'settings.shortcuts.label.opt+left': 'move by word',
    'settings.shortcuts.label.opt+right': 'move by word',
    'settings.shortcuts.label.opt+up': 'move by paragraph',
    'settings.shortcuts.label.opt+down': 'move by paragraph',
    'settings.shortcuts.label.cmd+left': 'line start',
    'settings.shortcuts.label.cmd+right': 'line end',
    'settings.shortcuts.label.cmd+up': 'start',
    'settings.shortcuts.label.cmd+down': 'end',
    'settings.shortcuts.label.ctrl+cmd+q': 'lock screen',
    'settings.shortcuts.label.shift+cmd+q': 'log out',
    'settings.shortcuts.label.opt+cmd+escape': 'force quit',
    'settings.shortcuts.label.cmd+space': 'Spotlight',
    'settings.shortcuts.label.ctrl+space': 'input source',
    'settings.shortcuts.label.cmd+tab': 'switch app',
    'settings.shortcuts.label.opt+cmd+h': 'hide others',
    'settings.shortcuts.label.shift+cmd+3': 'screenshot',
    'settings.shortcuts.label.shift+cmd+4': 'screenshot',
    'settings.shortcuts.label.shift+cmd+5': 'screenshot',
    'settings.shortcuts.label.ctrl+up': 'Mission Control',
    'settings.shortcuts.label.ctrl+down': 'app windows',
    'settings.shortcuts.label.ctrl+left': 'switch space',
    'settings.shortcuts.label.ctrl+right': 'switch space',
    'settings.shortcuts.label.opt+cmd+d': 'hide the Dock',
    'settings.shortcuts.label.ctrl+f2': 'focus the menu bar',
};
			},
			"settings/model.js": function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OUTCOMES = exports.ACTION_WHATS = exports.SUMMARY_KINDS = exports.SETTINGS_ERROR_CODES = exports.PAGE_SETTINGS_CODES = exports.DAEMON_REASONS = exports.HOST_SETTINGS_CODES = exports.SnapshotError = exports.SETTINGS_IDLE_POLL_MS = exports.SETTINGS_ACTIVE_POLL_MS = exports.PAGE_TABS = exports.SETTINGS_TABS = void 0;
exports.readSnapshot = readSnapshot;
exports.pollDelay = pollDelay;
exports.appName = appName;
exports.settingsErrorMessage = settingsErrorMessage;
exports.reasonText = reasonText;
exports.whatText = whatText;
exports.summaryText = summaryText;
exports.shortTask = shortTask;
exports.outcomeNotice = outcomeNotice;
exports.resultText = resultText;
exports.SETTINGS_TABS = ['overview', 'access', 'apps', 'shortcuts', 'privacy', 'behavior', 'logs'];
exports.PAGE_TABS = ['daemon', ...exports.SETTINGS_TABS];
exports.SETTINGS_ACTIVE_POLL_MS = 1000;
exports.SETTINGS_IDLE_POLL_MS = 10_000;
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const isString = (v) => typeof v === 'string';
const nullOr = (v, read) => (v === null ? null : read(v));
class SnapshotError extends Error {
    code = 'bad_response';
}
exports.SnapshotError = SnapshotError;
function fail(what) {
    throw new SnapshotError(`the settings snapshot has no valid ${what}`);
}
function arrayOf(v, what, read) {
    if (!Array.isArray(v))
        fail(what);
    return v.map((item) => read(item) ?? fail(what));
}
function readApp(v) {
    if (!isObject(v) || !isString(v.bundle_id))
        return undefined;
    return { bundle_id: v.bundle_id, name: isString(v.name) ? v.name : null };
}
function readGrant(v) {
    if (!isObject(v) || !isString(v.task_id) || !isNumber(v.expires_at) || !Array.isArray(v.apps))
        return undefined;
    const apps = [];
    for (const a of v.apps) {
        const app = readApp(a);
        if (app === undefined || !isObject(a) || !isNumber(a.expires_at))
            return undefined;
        apps.push({
            ...app,
            mode: a.mode === 'read' || a.mode === 'full' ? a.mode : null,
            scope: a.scope === 'turn' || a.scope === 'session' || a.scope === 'always' ? a.scope : null,
            expires_at: a.expires_at,
        });
    }
    return { task_id: v.task_id, expires_at: v.expires_at, by_dialog: v.by_dialog === true, owner_gone: v.owner_gone === true, apps };
}
function readRefusal(v) {
    if (!isObject(v) || !isNumber(v.at) || !isString(v.method) || !isString(v.reason))
        return undefined;
    return { at: v.at, method: v.method, app: isString(v.app) ? v.app : null, reason: v.reason };
}
function readChange(v) {
    if (!isObject(v) || !isNumber(v.at) || !isString(v.method))
        return undefined;
    return {
        at: v.at, method: v.method, app: isString(v.app) ? v.app : null, reason: isString(v.reason) ? v.reason : null,
        verified: typeof v.verified === 'boolean' ? v.verified : null,
    };
}
function readPermissions(v) {
    if (!isObject(v) || typeof v.accessibility !== 'boolean' || typeof v.screen_recording !== 'boolean')
        return undefined;
    return {
        accessibility: v.accessibility, screen_recording: v.screen_recording,
        input_monitoring: typeof v.input_monitoring === 'boolean' ? v.input_monitoring : null,
    };
}
function readOutcome(v) {
    if (!isObject(v) || !isNumber(v.at) || !isString(v.kind) || !isString(v.outcome))
        return undefined;
    return { at: v.at, kind: v.kind, outcome: v.outcome, ...(isString(v.reason) ? { reason: v.reason } : {}) };
}
function readChords(v) {
    if (!isObject(v))
        return undefined;
    return {
        builtin: arrayOf(v.builtin, 'chords.builtin', (c) => isObject(c) && isString(c.chord) && typeof c.enabled === 'boolean' ? { chord: c.chord, enabled: c.enabled } : undefined),
        never: arrayOf(v.never, 'chords.never', (c) => (isString(c) ? c : undefined)),
        custom: arrayOf(v.custom, 'chords.custom', (c) => isObject(c) && isString(c.chord)
            ? { chord: c.chord, app: isString(c.app) ? c.app : null, note: isString(c.note) ? c.note : '' } : undefined),
    };
}
const record = (v, what) => (isObject(v) ? v : fail(what));
function readSnapshot(raw) {
    const s = record(raw, 'body');
    const persistent = arrayOf(s.persistent, 'persistent', (v) => {
        const app = readApp(v);
        if (app === undefined || !isObject(v) || !isString(v.mode))
            return undefined;
        return { ...app, mode: v.mode, added_at: isNumber(v.added_at) ? v.added_at : 0,
            signature_ok: typeof v.signature_ok === 'boolean' ? v.signature_ok : null };
    });
    const choices = record(s.access_choices, 'access_choices');
    const pending = nullOr(s.pending, (v) => (isObject(v) && isString(v.kind) ? v : undefined));
    const permissions = nullOr(s.permissions ?? null, readPermissions);
    const lastOutcome = nullOr(s.last_outcome ?? null, readOutcome);
    const picked = nullOr(s.picked_app ?? null, readApp);
    const preview = nullOr(s.import_preview ?? null, (v) => (isObject(v) ? v : undefined));
    const panel = nullOr(s.panel ?? null, (v) => (isString(v) ? v : undefined));
    if (pending === undefined)
        fail('pending');
    if (permissions === undefined)
        fail('permissions');
    if (lastOutcome === undefined)
        fail('last_outcome');
    if (picked === undefined)
        fail('picked_app');
    if (preview === undefined)
        fail('import_preview');
    if (panel === undefined)
        fail('panel');
    return {
        started_at: isNumber(s.started_at) ? s.started_at : fail('started_at'),
        grants: arrayOf(s.grants, 'grants', readGrant),
        persistent,
        denylist: arrayOf(s.denylist, 'denylist', (v) => {
            const app = readApp(v);
            return app === undefined || !isObject(v) ? undefined : { ...app, note: isString(v.note) ? v.note : '' };
        }),
        hard_deny: arrayOf(s.hard_deny, 'hard_deny', (v) => isObject(v) && (isString(v.bundle_id) || isString(v.namespace))
            ? { ...(isString(v.bundle_id) ? { bundle_id: v.bundle_id } : { namespace: v.namespace }),
                name: isString(v.name) ? v.name : null, category: isString(v.category) ? v.category : '' } : undefined),
        access: record(s.access, 'access'),
        access_choices: Object.fromEntries(Object.entries(choices).map(([k, v]) => [k, Array.isArray(v) ? v : fail(`access_choices.${k}`)])),
        chords: readChords(s.chords) ?? fail('chords'),
        privacy: record(s.privacy, 'privacy'),
        behavior: record(s.behavior, 'behavior'),
        logs: record(s.logs, 'logs'),
        recent_refusals: arrayOf(s.recent_refusals, 'recent_refusals', readRefusal),
        recent_changes: arrayOf(s.recent_changes, 'recent_changes', readChange),
        permissions, pending, last_outcome: lastOutcome, picked_app: picked, import_preview: preview, panel,
    };
}
function pollDelay(snapshot) {
    return snapshot !== null && (snapshot.pending !== null || snapshot.panel !== null) ? exports.SETTINGS_ACTIVE_POLL_MS : exports.SETTINGS_IDLE_POLL_MS;
}
function appName(snapshot, bundleId) {
    if (snapshot === null)
        return null;
    const id = bundleId.toLowerCase();
    const apps = [...snapshot.grants.flatMap((g) => g.apps), ...snapshot.persistent, ...snapshot.denylist,
        ...(snapshot.picked_app === null ? [] : [snapshot.picked_app])];
    for (const a of apps)
        if (a.bundle_id.toLowerCase() === id && a.name !== null)
            return a.name;
    for (const a of snapshot.hard_deny)
        if (a.bundle_id?.toLowerCase() === id && a.name !== null)
            return a.name;
    return null;
}
exports.HOST_SETTINGS_CODES = ['bad_request', 'busy', 'not_running', 'internal', 'daemon_error'];
exports.DAEMON_REASONS = ['verification_required', 'verify_busy', 'verify_cooldown', 'verify_unavailable',
    'verify_failed', 'verify_cancelled', 'approval_open', 'settings_unavailable', 'nothing_pending', 'settings_changed',
    'not_found', 'app_not_grantable', 'app_not_found', 'hard_denied', 'user_denied', 'invalid_chord',
    'chord_never_allowed', 'chord_builtin', 'log_directory_missing', 'invalid_params'];
exports.PAGE_SETTINGS_CODES = ['unauthorized', 'network', 'bad_response'];
exports.SETTINGS_ERROR_CODES = [...exports.HOST_SETTINGS_CODES, ...exports.DAEMON_REASONS, ...exports.PAGE_SETTINGS_CODES];
function settingsErrorMessage(t, failure, now) {
    const until = failure.data?.until;
    const text = failure.code === 'verify_cooldown'
        ? isNumber(until) ? t('settings.error.verify_cooldown', { seconds: Math.max(1, Math.ceil(until - now / 1000)) })
            : t('settings.error.verify_cooldownUntimed')
        : exports.SETTINGS_ERROR_CODES.includes(failure.code) ? t(`settings.error.${failure.code}`)
            : t('settings.error.unknown', { code: failure.code });
    const message = failure.message.trim();
    return { text, detail: message === '' ? null : t('settings.error.detail', { message }), toDaemon: failure.code === 'not_running' };
}
function reasonText(t, reason) {
    return exports.DAEMON_REASONS.includes(reason) && reason !== 'verify_cooldown' ? t(`settings.error.${reason}`)
        : t('settings.reasonCode', { reason });
}
exports.SUMMARY_KINDS = ['revoke', 'revoke_all',
    'persistent.remove', 'persistent.add', 'persistent.mode', 'persistent.reapprove', 'deny.add', 'deny.remove',
    'access.set', 'chord.disable', 'chord.enable', 'chord.add', 'chord.remove', 'privacy.set', 'text_only.add',
    'text_only.remove', 'clipboard.set', 'behavior.set', 'logs.retention', 'logs.default_directory', 'reset',
    'logs.directory', 'import'];
exports.ACTION_WHATS = ['choose_log_directory', 'use_default_log_directory', 'choose_app', 'export_settings',
    'export_audit', 'import_confirm', 'reveal_log'];
const ACCESS_FIELDS = ['default_mode', 'session_limit_minutes', 'dialogs_per_turn', 'dialog_timeout_seconds', 'dialog_default'];
const PRIVACY_FIELDS = ['send_screenshots', 'send_ax_text', 'send_ocr', 'send_zoom'];
const BEHAVIOR_FIELDS = ['restore_focus_on_turn_end', 'allow_point_targets', 'ime_policy_cap', 'electron_ax_auto', 'activation_method'];
function whatText(t, kind) {
    return exports.SUMMARY_KINDS.includes(kind) || exports.ACTION_WHATS.includes(kind)
        ? t(`settings.what.${kind}`) : t('settings.what.other', { kind });
}
function appWords(t, snapshot, bundleId) {
    if (!isString(bundleId))
        return t('settings.app.unknown');
    const name = appName(snapshot, bundleId);
    return name === null || name === bundleId ? t('settings.app.id', { id: bundleId }) : t('settings.app.named', { name, id: bundleId });
}
const onOff = (t, on) => t(on === true ? 'settings.value.on' : 'settings.value.off');
const NAMED_VALUES = {
    default_mode: ['ask', 'read', 'full'],
    dialog_default: ['deny', 'turn', 'session', 'always'],
    ime_policy_cap: ['leave', 'ask', 'takeover'],
    activation_method: ['running_application', 'ax_frontmost', 'ax_raise'],
};
function valueWords(t, field, value) {
    switch (field) {
        case 'default_mode':
        case 'dialog_default':
        case 'ime_policy_cap':
        case 'activation_method':
            if (field === 'activation_method' && value === null)
                return t('settings.value.activation_method.default');
            return isString(value) && NAMED_VALUES[field].includes(value) ? t(`settings.value.${field}.${value}`) : JSON.stringify(value);
        case 'session_limit_minutes': return t('settings.unit.minutes', { n: value });
        case 'dialogs_per_turn': return t('settings.unit.times', { n: value });
        case 'dialog_timeout_seconds': return t('settings.unit.seconds', { n: value });
        default: return typeof value === 'boolean' ? onOff(t, value) : JSON.stringify(value);
    }
}
function loosenedWords(t, loosened) {
    const items = Array.isArray(loosened) ? loosened.filter(isString) : [];
    return items.length === 0 ? t('settings.value.none') : items.join(t('settings.listSeparator'));
}
function summaryText(t, summary, snapshot) {
    const s = summary;
    const app = (key = 'bundle_id') => appWords(t, snapshot, s[key]);
    const mode = () => (s.mode === 'read' || s.mode === 'full' ? t(`settings.mode.${s.mode}`) : String(s.mode));
    switch (s.kind) {
        case 'revoke': return t('settings.summary.revoke', { task: isString(s.task_id) ? shortTask(s.task_id) : '?' });
        case 'revoke_all':
        case 'logs.default_directory': return t(`settings.summary.${s.kind}`);
        case 'persistent.remove':
        case 'persistent.reapprove':
        case 'deny.remove':
        case 'text_only.add':
        case 'text_only.remove': return t(`settings.summary.${s.kind}`, { app: app() });
        case 'persistent.add':
        case 'persistent.mode': return t(`settings.summary.${s.kind}`, { app: app(), mode: mode() });
        case 'deny.add': return t('settings.summary.deny.add', { app: app() });
        case 'access.set':
        case 'behavior.set': {
            const fields = s.kind === 'access.set' ? ACCESS_FIELDS : BEHAVIOR_FIELDS;
            const group = s.kind === 'access.set' ? 'access' : 'behavior';
            const field = isString(s.field) && fields.includes(s.field) ? t(`settings.field.${group}.${s.field}`) : String(s.field);
            return t(`settings.summary.${s.kind}`, { field, value: valueWords(t, String(s.field), s.value) });
        }
        case 'chord.disable':
        case 'chord.enable': return t(`settings.summary.${s.kind}`, { chord: String(s.chord) });
        case 'chord.add':
        case 'chord.remove':
            return t(`settings.summary.${s.kind}`, { chord: String(s.chord), app: s.app === null ? t('settings.app.everyApproved') : app('app') });
        case 'privacy.set': {
            const field = isString(s.field) && PRIVACY_FIELDS.includes(s.field) ? t(`settings.field.privacy.${s.field}`) : String(s.field);
            return t(s.on === true ? 'settings.summary.privacy.on' : 'settings.summary.privacy.off', { field });
        }
        case 'clipboard.set': return t(s.on === true ? 'settings.summary.clipboard.on' : 'settings.summary.clipboard.off');
        case 'logs.retention': return t('settings.summary.logs.retention', { days: t('settings.unit.days', { n: s.days }) });
        case 'logs.directory': return t('settings.summary.logs.directory', { directory: String(s.directory) });
        case 'reset':
        case 'import': return t(`settings.summary.${s.kind}`, { loosened: loosenedWords(t, s.loosened) });
        default: return t('settings.summary.other', { kind: s.kind });
    }
}
function shortTask(taskId) {
    return taskId.replace('dsh-', '').slice(0, 8);
}
exports.OUTCOMES = ['applied', 'done', 'verify_failed', 'verify_cancelled', 'verify_unavailable', 'cancelled', 'refused'];
function outcomeNotice(t, outcome, since, dismissed) {
    if (outcome === null || outcome.at < since / 1000 - 1)
        return null;
    const key = `${outcome.at}:${outcome.kind}:${outcome.outcome}`;
    if (key === dismissed)
        return null;
    const what = whatText(t, outcome.kind);
    const known = exports.OUTCOMES.includes(outcome.outcome);
    const text = !known ? t('settings.outcome.other', { what, outcome: outcome.outcome })
        : outcome.outcome === 'refused' ? t('settings.outcome.refused', { what, reason: reasonText(t, outcome.reason ?? '') })
            : t(`settings.outcome.${outcome.outcome}`, { what });
    return { key, text, state: outcome.outcome === 'applied' || outcome.outcome === 'done' ? 'done' : 'warning' };
}
function resultText(t, what, result) {
    switch (result.status) {
        case 'open': return t('settings.result.open', { what: whatText(t, what) });
        case 'busy': return t('settings.result.busy', { panel: result.panel === undefined ? '?' : whatText(t, result.panel) });
        case 'applied':
        case 'done': return t(`settings.result.${result.status}`, { what: whatText(t, what) });
        default: return null;
    }
}
			},
			"settings/shell.js": function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PluginPage = PluginPage;
const react_1 = require("react");
const page_ts_1 = require("../page.js");
const api_ts_1 = require("./api.js");
const model_ts_1 = require("./model.js");
const index_ts_1 = require("./tabs/index.js");
const ui_ts_1 = require("./ui.js");
const DROPS_SNAPSHOT = new Set(['not_running', 'busy']);
function PluginPage(props) {
    const [tab, setTab] = (0, react_1.useState)('daemon');
    if (props.view === 'summary')
        return (0, react_1.createElement)(page_ts_1.Page, props);
    const { t } = props;
    return (0, react_1.createElement)('div', { style: { ...ui_ts_1.STYLES.tab, fontSize: 13, lineHeight: 1.5 }, 'data-cu-runtime-plugin-page': '' }, (0, ui_ts_1.tabBar)({
        label: t('settings.tabs.label'), value: tab, onChange: (value) => setTab(value),
        items: model_ts_1.PAGE_TABS.map((id) => ({ value: id, label: t(`settings.tab.${id}`) })),
    }), (0, react_1.createElement)('div', { role: 'tabpanel', id: (0, ui_ts_1.tabPanelId)(tab), 'aria-labelledby': `cu-runtime-tab-${tab}`, 'data-cu-runtime-tab-panel': tab }, tab === 'daemon' ? (0, react_1.createElement)(page_ts_1.Page, props) : (0, react_1.createElement)(SettingsPage, { t, tab, goTo: setTab })));
}
function TabHost({ module, props, ui }) {
    return module.render(props, ui);
}
function failureBlock(t, failure, now, goTo, key) {
    const message = (0, model_ts_1.settingsErrorMessage)(t, failure, now);
    return (0, react_1.createElement)('div', { key, role: 'alert', style: { display: 'grid', gap: 4 }, 'data-cu-runtime-error': failure.code }, (0, react_1.createElement)('p', { style: ui_ts_1.STYLES.error }, message.text), message.detail === null ? null : (0, react_1.createElement)('p', { style: ui_ts_1.STYLES.error }, message.detail), message.toDaemon ? (0, react_1.createElement)('div', { style: ui_ts_1.STYLES.actions }, (0, ui_ts_1.button)({ key: 'toDaemon', label: t('settings.toDaemon'), onClick: () => goTo('daemon') })) : null);
}
function SettingsPage({ t, tab, goTo }) {
    const [snapshot, setSnapshot] = (0, react_1.useState)(null);
    const [readError, setReadError] = (0, react_1.useState)(null);
    const [inFlight, setInFlight] = (0, react_1.useState)(false);
    const [requestError, setRequestError] = (0, react_1.useState)(null);
    const [answer, setAnswer] = (0, react_1.useState)(null);
    const [dismissed, setDismissed] = (0, react_1.useState)(null);
    const [since] = (0, react_1.useState)(() => Date.now());
    const [round, setRound] = (0, react_1.useState)(0);
    const [readRound, setReadRound] = (0, react_1.useState)(0);
    (0, react_1.useEffect)(() => {
        let stopped = false;
        let timer;
        const controller = new AbortController();
        const poll = async () => {
            let delay = model_ts_1.SETTINGS_IDLE_POLL_MS;
            try {
                const next = await (0, api_ts_1.fetchSnapshot)(controller.signal);
                if (stopped)
                    return;
                setSnapshot(next);
                setReadRound(round);
                setReadError(null);
                delay = (0, model_ts_1.pollDelay)(next);
            }
            catch (error) {
                if (stopped)
                    return;
                const failure = (0, api_ts_1.asSettingsFailure)(error);
                setReadError(failure);
                if (DROPS_SNAPSHOT.has(failure.code))
                    setSnapshot(null);
            }
            timer = setTimeout(() => void poll(), delay);
        };
        void poll();
        return () => {
            stopped = true;
            clearTimeout(timer);
            controller.abort();
        };
    }, [round]);
    const send = (0, react_1.useCallback)(async (what, request) => {
        setInFlight(true);
        setRequestError(null);
        setAnswer(null);
        try {
            setAnswer((0, model_ts_1.resultText)(t, what, await request()));
            return true;
        }
        catch (error) {
            setRequestError((0, api_ts_1.asSettingsFailure)(error));
            return false;
        }
        finally {
            setInFlight(false);
            setRound((n) => n + 1);
        }
    }, [t]);
    const apply = (0, react_1.useCallback)((change) => send(change.kind, () => (0, api_ts_1.applyChange)(change)), [send]);
    const action = (0, react_1.useCallback)((name) => send(name, () => (0, api_ts_1.runAction)(name)), [send]);
    const now = Date.now();
    const pending = snapshot === null || snapshot.pending !== null || inFlight || readRound !== round;
    const notice = (0, model_ts_1.outcomeNotice)(t, snapshot?.last_outcome ?? null, since, dismissed);
    const props = { snapshot, t, pending, apply, action, goTo, now };
    return (0, react_1.createElement)('div', { style: ui_ts_1.STYLES.tab, 'data-cu-runtime-settings': tab }, snapshot === null && readError === null ? (0, react_1.createElement)('p', { role: 'status', style: ui_ts_1.STYLES.quiet }, t('settings.loading')) : null, snapshot?.pending == null ? null : (0, react_1.createElement)('section', {
        role: 'status', 'aria-live': 'polite', 'data-cu-runtime-pending': snapshot.pending.kind,
        style: { ...ui_ts_1.STYLES.card, borderColor: 'var(--dsw-alias-state-warn-primary)' },
    }, (0, react_1.createElement)('p', { style: { ...ui_ts_1.STYLES.line, fontWeight: 600 } }, (0, ui_ts_1.dot)('ongoing'), (0, react_1.createElement)('span', null, t('settings.pending.title', { summary: (0, model_ts_1.summaryText)(t, snapshot.pending, snapshot) }))), (0, react_1.createElement)('p', { style: ui_ts_1.STYLES.warn }, t('settings.pending.verify')), (0, react_1.createElement)('p', { style: ui_ts_1.STYLES.quiet }, t('settings.pending.locked')), (0, react_1.createElement)('div', { style: ui_ts_1.STYLES.actions }, (0, ui_ts_1.button)({ key: 'cancelVerify', label: t('settings.pending.cancel'), disabled: inFlight,
        onClick: () => void send('cancel', api_ts_1.cancelVerify) }))), notice === null ? null : (0, react_1.createElement)('div', { role: 'status', style: ui_ts_1.STYLES.line, 'data-cu-runtime-outcome': notice.key }, (0, ui_ts_1.dot)(notice.state), (0, react_1.createElement)('span', { style: { flex: '1 1 auto', minWidth: 0 } }, notice.text), (0, ui_ts_1.button)({ key: 'dismiss', label: t('settings.notice.dismiss'), onClick: () => setDismissed(notice.key), variant: 'ghost' })), answer === null ? null : (0, react_1.createElement)('p', { role: 'status', style: ui_ts_1.STYLES.quiet, 'data-cu-runtime-answer': '' }, answer), requestError === null ? null : failureBlock(t, requestError, now, goTo, 'requestError'), readError === null || readError.code === requestError?.code ? null : failureBlock(t, readError, now, goTo, 'readError'), (0, react_1.createElement)(TabHost, { key: tab, module: index_ts_1.TAB_MODULES[tab], props, ui: (0, ui_ts_1.makeKit)(t) }));
}
			},
			"settings/tab.js": function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
			},
			"settings/tabs/access.js": function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.tab = exports.FULL_POWER = exports.ACCESS_FIELDS = void 0;
exports.offeredValues = offeredValues;
exports.buildAccessView = buildAccessView;
exports.ACCESS_FIELDS = ['default_mode', 'session_limit_minutes', 'dialogs_per_turn',
    'dialog_timeout_seconds', 'dialog_default'];
exports.FULL_POWER = 'max';
const NAMED = {
    default_mode: ['ask', 'read', 'full'],
    dialog_default: ['deny', 'turn', 'session', 'always'],
};
const UNITS = {
    session_limit_minutes: 'minutes', dialogs_per_turn: 'times', dialog_timeout_seconds: 'seconds',
};
function offeredValues(snapshot, field) {
    const raw = snapshot?.access_choices[field];
    if (!Array.isArray(raw))
        return [];
    const out = [];
    for (const v of raw) {
        const fits = NAMED[field] !== undefined ? typeof v === 'string' && v !== '' : typeof v === 'number' && Number.isInteger(v);
        if (fits && !out.some((o) => String(o) === String(v)))
            out.push(v);
    }
    return out;
}
function valueLabel(t, field, value) {
    const unit = UNITS[field];
    if (unit !== undefined)
        return t(`settings.unit.${unit}`, { n: value });
    return typeof value === 'string' && NAMED[field]?.includes(value) ? t(`settings.value.${field}.${value}`) : String(value);
}
function storedValue(snapshot, field) {
    const v = snapshot?.access[field];
    return typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)) ? String(v) : '';
}
function row(t, snapshot, field, text, lock, enabled) {
    const value = storedValue(snapshot, field);
    const options = offeredValues(snapshot, field).map((v) => ({
        value: String(v),
        label: valueLabel(t, field, v),
        disabled: false,
        change: !enabled || String(v) === value ? null : { kind: 'access.set', ...{ field, value: v } },
    }));
    if (field === 'default_mode' && options.length > 0) {
        options.push({ value: exports.FULL_POWER, label: t('settings.access.fullPower'), disabled: true, change: null });
    }
    return {
        field,
        title: t(`settings.access.${text}.title`),
        note: t(`settings.access.${text}.note`),
        lock: lock ? t(`settings.access.${text}.lock`) : null,
        value, options, enabled,
        noChoices: t('settings.access.noChoices'),
    };
}
function buildAccessView(snapshot, { t, pending }) {
    const enabled = !pending && snapshot !== null;
    const items = (tier) => [1, 2, 3, 4].map((i) => t(`settings.access.tier.${tier}.item${i}`));
    return {
        title: t('settings.access.title'),
        note: t('settings.access.note'),
        ready: snapshot !== null,
        tiers: [
            { id: 'read', chip: { text: t('settings.mode.read'), tone: 'info' }, title: t('settings.access.tier.read.title'), items: items('read'), note: null },
            { id: 'full', chip: { text: t('settings.mode.full'), tone: 'warning' }, title: t('settings.access.tier.full.title'), items: items('full'), note: null },
            { id: 'max', chip: { text: t('settings.access.fullPower'), tone: 'danger' }, title: t('settings.access.tier.max.title'), items: items('max'),
                note: t('settings.access.tier.max.note') },
        ],
        cards: [
            { key: 'newSession', title: t('settings.access.newSession'), rows: [row(t, snapshot, 'default_mode', 'defaultMode', true, enabled)] },
            { key: 'session', title: t('settings.access.session.title'), rows: [row(t, snapshot, 'session_limit_minutes', 'session', true, enabled)] },
            { key: 'dialogs', title: t('settings.access.dialogs.title'), rows: [
                    row(t, snapshot, 'dialogs_per_turn', 'dialogs', true, enabled),
                    row(t, snapshot, 'dialog_timeout_seconds', 'timeout', false, enabled),
                    row(t, snapshot, 'dialog_default', 'defaultButton', true, enabled),
                ] },
        ],
        fixedRules: { title: t('settings.access.fixedRules'), items: [1, 2, 3, 4].map((i) => t(`settings.access.fixedRule${i}`)) },
    };
}
exports.tab = {
    id: 'access',
    render(props, ui) {
        const { h, styles } = ui;
        const view = buildAccessView(props.snapshot, props);
        const bullets = (key, items) => h('ul', { key, style: { margin: 0, paddingLeft: 18, display: 'grid', gap: 3 } }, ...items.map((item, i) => h('li', { key: String(i), style: styles.note }, item)));
        const header = h('div', { key: 'header', style: { display: 'grid', gap: 2 } }, h('h3', { style: { ...styles.heading, fontSize: 15 } }, view.title), h('p', { style: styles.note }, view.note));
        const tiers = h('div', { key: 'tiers', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14 } }, ...view.tiers.map((c) => h('section', { key: c.id, 'data-tier': c.id,
            style: { display: 'grid', gap: 8, alignContent: 'start', padding: 16, borderRadius: 12, border: '1px solid var(--dsw-alias-border-l2)' } }, h('div', { style: styles.line }, ui.tag(c.chip.text, c.chip.tone)), h('h4', { style: styles.heading }, c.title), bullets('items', c.items), c.note === null ? null : h('p', { style: styles.quiet }, c.note))));
        const control = (r) => r.options.length === 0 ? h('p', { style: styles.quiet }, r.noChoices)
            : ui.segmented({
                id: `cu-runtime-access-${r.field}`, label: r.title, value: r.value, disabled: !r.enabled,
                options: r.options.map((o) => ({ value: o.value, label: o.label, disabled: o.disabled })),
                onChange: (next) => {
                    const change = r.options.find((o) => o.value === next)?.change ?? null;
                    if (r.enabled && change !== null)
                        void props.apply(change);
                },
            });
        const rowNode = (r) => h('div', { key: r.field, style: { ...styles.row, alignItems: 'flex-start' }, 'data-access-field': r.field }, h('div', { style: { display: 'grid', gap: 2, flex: '1 1 240px', minWidth: 0 } }, h('span', { style: styles.heading }, r.title), h('p', { style: styles.note }, r.note)), h('div', { style: { display: 'grid', gap: 6, justifyItems: 'end', flex: '0 1 auto', minWidth: 0 } }, control(r), r.lock === null ? null : h('span', { style: { ...styles.warn, fontSize: 11 }, 'data-lock': r.field }, r.lock)));
        const cards = view.cards.map((c) => ui.card({ key: c.key, title: c.title, children: c.rows.map(rowNode) }));
        const fixed = ui.card({ key: 'fixedRules', title: view.fixedRules.title, children: [bullets('rules', view.fixedRules.items)] });
        return h('div', { style: styles.tab, 'data-cu-runtime-tab': 'access' }, header, tiers, ...cards, fixed);
    },
};
			},
			"settings/tabs/apps.js": function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.tab = exports.FLOOR_CATEGORIES = exports.NO_FORMS = void 0;
exports.bundleIdOf = bundleIdOf;
exports.noteOf = noteOf;
exports.pickOutcome = pickOutcome;
exports.dayTime = dayTime;
exports.buildAppsView = buildAppsView;
const change_ts_1 = require("../change.js");
exports.NO_FORMS = { always: null, deny: null, waiting: null };
exports.FLOOR_CATEGORIES = ['systemUI', 'authentication', 'runsCode', 'selfAndRemote'];
const CONTROL = /[\p{Cc}\p{Cf}]/u;
function bundleIdOf(text) {
    const id = text.trim();
    return id.length > 0 && id.length <= change_ts_1.CHANGE_LIMITS.bundleId && !/\s/.test(id) && !CONTROL.test(id) ? id : null;
}
function noteOf(text) {
    const note = text.trim();
    return note.length <= change_ts_1.CHANGE_LIMITS.note && !CONTROL.test(note) ? note : null;
}
function pickOutcome(snapshot, since) {
    const outcome = snapshot?.last_outcome ?? null;
    if (snapshot === null || outcome === null || outcome.kind !== 'choose_app' || outcome.at < since)
        return { status: 'waiting' };
    return outcome.outcome === 'done' && snapshot.picked_app !== null ? { status: 'picked', app: snapshot.picked_app } : { status: 'ended' };
}
const pad = (n) => String(n).padStart(2, '0');
function dayTime(t, at) {
    if (!(at > 0))
        return t('settings.value.none');
    const d = new Date(at * 1000);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function modeChip(t, mode) {
    if (mode === 'read')
        return { text: t('settings.mode.read'), tone: 'info' };
    if (mode === 'full')
        return { text: t('settings.mode.full'), tone: 'warning' };
    return { text: mode, tone: 'neutral' };
}
function alwaysRow(t, e, pending) {
    const id = e.bundle_id;
    const state = e.signature_ok === true ? 'ok' : e.signature_ok === false ? 'changed' : 'unknown';
    return {
        key: id,
        app: { bundle_id: id, name: e.name },
        mode: modeChip(t, e.mode),
        added: t('settings.apps.always.added', { time: dayTime(t, e.added_at) }),
        signature: { state, text: t(`settings.apps.always.signature.${state}`), tone: state === 'ok' ? 'success' : state === 'changed' ? 'warning' : 'quiet' },
        reapprove: state === 'changed'
            ? { label: t('settings.apps.always.reapprove'), enabled: !pending, change: { kind: 'persistent.reapprove', bundle_id: id } } : null,
        changeMode: {
            label: t('settings.apps.always.changeMode'), value: e.mode, enabled: !pending,
            options: ['read', 'full'].map((mode) => ({ value: mode, label: t(`settings.mode.${mode}`),
                change: { kind: 'persistent.mode', bundle_id: id, mode } })),
        },
        remove: { label: t('settings.apps.always.remove'), enabled: !pending, change: { kind: 'persistent.remove', bundle_id: id } },
    };
}
function floorItem(e, i) {
    if (e.bundle_id !== undefined)
        return { key: `${e.bundle_id}:${i}`, text: e.name ?? e.bundle_id, id: e.bundle_id };
    const id = `${e.namespace ?? ''}.*`;
    return { key: `${id}:${i}`, text: e.name ?? id, id };
}
function floorGroups(t, floor) {
    const known = exports.FLOOR_CATEGORIES;
    const ids = [...exports.FLOOR_CATEGORIES, 'other'];
    return ids.map((id) => ({
        id,
        title: t(`settings.apps.floor.category.${id}`),
        items: floor.map((e, i) => [e, i])
            .filter(([e]) => (id === 'other' ? !known.includes(e.category) : e.category === id))
            .map(([e, i]) => floorItem(e, i)),
    })).filter((g) => g.items.length > 0);
}
function buildAppsView(snapshot, { t, pending, forms = exports.NO_FORMS }) {
    const waiting = t('settings.apps.waiting');
    const choosing = forms.waiting !== null;
    const always = forms.always;
    const deny = forms.deny;
    const denyId = deny === null ? null : bundleIdOf(deny.id);
    const denyNote = deny === null ? null : noteOf(deny.note);
    const floor = snapshot?.hard_deny ?? [];
    return {
        title: t('settings.apps.title'),
        note: t('settings.apps.note'),
        ready: snapshot !== null,
        always: {
            title: t('settings.apps.always.title'),
            note: t('settings.apps.always.note'),
            add: { label: t('settings.apps.always.add'), enabled: !pending && !choosing && always === null },
            rows: (snapshot?.persistent ?? []).map((e) => alwaysRow(t, e, pending)),
            empty: t('settings.apps.always.empty'),
            waiting: forms.waiting === 'always' ? waiting : null,
            form: always === null ? null : {
                title: t('settings.apps.always.form.title'),
                app: always.app,
                modeLabel: t('settings.apps.always.form.mode'),
                mode: always.mode,
                modes: ['read', 'full'].map((mode) => ({ value: mode, label: t(`settings.mode.${mode}`) })),
                note: t('settings.apps.always.form.note'),
                chooseAgain: { label: t('settings.apps.always.form.chooseAgain'), enabled: !pending && !choosing },
                submit: { label: t('settings.apps.always.form.submit'), enabled: !pending,
                    change: { kind: 'persistent.add', bundle_id: always.app.bundle_id, mode: always.mode } },
            },
        },
        deny: {
            title: t('settings.apps.deny.title'),
            note: t('settings.apps.deny.note'),
            add: { label: t('settings.apps.deny.add'), enabled: !pending && deny === null },
            rows: (snapshot?.denylist ?? []).map((e) => ({
                key: e.bundle_id,
                app: { bundle_id: e.bundle_id, name: e.name },
                note: e.note === '' ? t('settings.value.none') : e.note,
                hasNote: e.note !== '',
                remove: { label: t('settings.apps.deny.remove'), enabled: !pending, change: { kind: 'deny.remove', bundle_id: e.bundle_id } },
            })),
            empty: t('settings.apps.deny.empty'),
            waiting: forms.waiting === 'deny' ? waiting : null,
            form: deny === null ? null : {
                title: t('settings.apps.deny.form.title'),
                idLabel: t('settings.apps.deny.form.bundleId'),
                id: deny.id,
                idHint: t('settings.apps.deny.form.bundleIdHint'),
                noteLabel: t('settings.apps.deny.form.note'),
                note: deny.note,
                notePlaceholder: t('settings.apps.deny.form.notePlaceholder'),
                chooseApp: { label: t('settings.apps.chooseApp'), enabled: !pending && !choosing },
                submit: { label: t('settings.apps.deny.form.submit'), enabled: !pending && denyId !== null && denyNote !== null,
                    change: { kind: 'deny.add', bundle_id: denyId ?? deny.id.trim(), note: denyNote ?? deny.note.trim() } },
            },
        },
        floor: {
            title: t('settings.apps.floor.title'),
            note: t('settings.apps.floor.note'),
            count: t('settings.apps.floor.count', { n: floor.length }),
            groups: floorGroups(t, floor),
            empty: t('settings.apps.floor.empty'),
        },
        stopWaiting: t('settings.apps.stopWaiting'),
        cancel: t('settings.cancel'),
    };
}
const FORM_STYLE = { display: 'grid', gap: 10, padding: 12, border: '.5px solid var(--dsw-alias-border-l4)', borderRadius: 10, minWidth: 0 };
exports.tab = {
    id: 'apps',
    render(props, ui) {
        const { h, styles } = ui;
        const [always, setAlways] = ui.useState(null);
        const [deny, setDeny] = ui.useState(null);
        const [pick, setPick] = ui.useState(null);
        ui.useEffect(() => {
            if (pick === null)
                return;
            const result = pickOutcome(props.snapshot, pick.since);
            if (result.status === 'waiting')
                return;
            setPick(null);
            if (result.status !== 'picked')
                return;
            if (pick.target === 'always')
                setAlways((a) => ({ app: result.app, mode: a?.mode ?? 'read' }));
            else
                setDeny((d) => (d === null ? d : { id: result.app.bundle_id, note: d.note }));
        }, [props.snapshot, pick]);
        const view = buildAppsView(props.snapshot, { t: props.t, pending: props.pending, forms: { always, deny, waiting: pick?.target ?? null } });
        const header = h('div', { key: 'header', style: { display: 'grid', gap: 2 } }, h('h3', { style: { ...styles.heading, fontSize: 15 } }, view.title), h('p', { style: styles.note }, view.note));
        if (!view.ready)
            return h('div', { style: styles.tab, 'data-cu-runtime-tab': 'apps' }, header);
        const choose = (target) => {
            const since = props.now / 1000;
            void props.action('choose_app').then((ok) => { if (ok)
                setPick({ target, since }); });
        };
        const send = (change, done) => {
            void props.apply(change).then((ok) => { if (ok)
                done?.(); });
        };
        const close = (target) => {
            if (target === 'always')
                setAlways(null);
            else
                setDeny(null);
            setPick((p) => (p?.target === target ? null : p));
        };
        const waitingLine = (key, text) => text === null ? null
            : h('div', { key, style: styles.row, role: 'status' }, h('p', { style: styles.quiet }, text), ui.button({ key: 'stop', label: view.stopWaiting, onClick: () => setPick(null), variant: 'ghost' }));
        const a = view.always;
        const alwaysForm = a.form === null ? null : h('div', { key: 'form', style: FORM_STYLE, 'data-cu-runtime-form': 'always' }, h('p', { style: styles.heading }, a.form.title), h('div', { style: styles.row }, h('div', { style: { flex: '1 1 160px', minWidth: 0 } }, ui.appLabel(a.form.app)), ui.button({ key: 'again', label: a.form.chooseAgain.label, disabled: !a.form.chooseAgain.enabled, onClick: () => choose('always') })), ui.segmented({ key: 'mode', id: 'cu-runtime-always-mode', label: a.form.modeLabel, value: a.form.mode, disabled: props.pending,
            options: a.form.modes, onChange: (next) => setAlways((f) => (f === null ? f : { ...f, mode: next === 'full' ? 'full' : 'read' })) }), h('p', { style: styles.note }, a.form.note), h('div', { style: styles.actions }, ui.button({ key: 'cancel', label: view.cancel, onClick: () => close('always') }), ui.button({ key: 'submit', label: a.form.submit.label, disabled: !a.form.submit.enabled, variant: 'primary',
            onClick: () => send(a.form.submit.change, () => close('always')) })));
        const alwaysCard = ui.card({
            key: 'always', title: a.title, note: a.note,
            trailing: ui.button({ key: 'add', label: a.add.label, disabled: !a.add.enabled, onClick: () => choose('always') }),
            children: [
                waitingLine('waiting', a.waiting),
                alwaysForm,
                ui.list({
                    key: 'list', label: a.title, empty: a.empty,
                    rows: a.rows.map((r) => h('div', { key: r.key, style: styles.row, 'data-persistent': r.key }, h('div', { style: { flex: '1 1 160px', minWidth: 0 } }, ui.appLabel(r.app)), ui.tag(r.mode.text, r.mode.tone), h('span', { 'data-signature': r.signature.state }, ui.tag(r.signature.text, r.signature.tone)), h('span', { style: { ...styles.quiet, fontSize: 12 } }, r.added), r.reapprove === null ? null : ui.button({ key: 'reapprove', label: r.reapprove.label, disabled: !r.reapprove.enabled,
                        onClick: () => send(r.reapprove.change) }), ui.segmented({ key: 'mode', id: `cu-runtime-mode-${r.key}`, label: r.changeMode.label, value: r.changeMode.value,
                        disabled: !r.changeMode.enabled, options: r.changeMode.options,
                        onChange: (next) => {
                            const option = r.changeMode.options.find((o) => o.value === next);
                            if (option !== undefined && next !== r.changeMode.value)
                                send(option.change);
                        } }), ui.button({ key: 'remove', label: r.remove.label, disabled: !r.remove.enabled, onClick: () => send(r.remove.change) }))),
                }),
            ],
        });
        const d = view.deny;
        const denyForm = d.form === null ? null : h('div', { key: 'form', style: FORM_STYLE, 'data-cu-runtime-form': 'deny' }, h('p', { style: styles.heading }, d.form.title), h('div', { style: styles.row }, ui.input({ key: 'id', label: d.form.idLabel, value: d.form.id, placeholder: 'com.example.app', maxLength: change_ts_1.CHANGE_LIMITS.bundleId,
            disabled: props.pending, onChange: (text) => setDeny((f) => (f === null ? f : { ...f, id: text })) }), ui.button({ key: 'choose', label: d.form.chooseApp.label, disabled: !d.form.chooseApp.enabled, onClick: () => choose('deny') })), h('p', { style: styles.note }, d.form.idHint), ui.input({ key: 'note', label: d.form.noteLabel, value: d.form.note, placeholder: d.form.notePlaceholder, maxLength: change_ts_1.CHANGE_LIMITS.note,
            disabled: props.pending, onChange: (text) => setDeny((f) => (f === null ? f : { ...f, note: text })) }), h('div', { style: styles.actions }, ui.button({ key: 'cancel', label: view.cancel, onClick: () => close('deny') }), ui.button({ key: 'submit', label: d.form.submit.label, disabled: !d.form.submit.enabled, variant: 'primary',
            onClick: () => send(d.form.submit.change, () => close('deny')) })));
        const denyCard = ui.card({
            key: 'deny', title: d.title, note: d.note,
            trailing: ui.button({ key: 'add', label: d.add.label, disabled: !d.add.enabled, onClick: () => setDeny({ id: '', note: '' }) }),
            children: [
                denyForm,
                waitingLine('waiting', d.waiting),
                ui.list({
                    key: 'list', label: d.title, empty: d.empty,
                    rows: d.rows.map((r) => h('div', { key: r.key, style: styles.row, 'data-deny': r.key }, h('div', { style: { flex: '1 1 160px', minWidth: 0 } }, ui.appLabel(r.app)), h('span', { style: { flex: '1 1 160px', minWidth: 0, fontSize: 12, ...(r.hasNote ? {} : styles.quiet) } }, r.note), ui.button({ key: 'remove', label: r.remove.label, disabled: !r.remove.enabled, onClick: () => send(r.remove.change) }))),
                }),
            ],
        });
        const f = view.floor;
        const floorCard = ui.card({
            key: 'floor', title: f.title, note: f.note,
            trailing: h('span', { style: { ...styles.quiet, fontSize: 12, flex: 'none' } }, f.count),
            children: [ui.list({
                    key: 'list', label: f.title, empty: f.empty,
                    rows: f.groups.map((g) => h('div', { key: g.id, style: { display: 'grid', gap: 6 }, 'data-floor-category': g.id }, h('p', { style: styles.heading }, g.title), h('div', { style: { ...styles.actions, gap: 6 } }, ...g.items.map((i) => h('span', { key: i.key, title: i.id, 'data-floor': i.id }, ui.tag(i.text, 'quiet')))))),
                })],
        });
        return h('div', { style: styles.tab, 'data-cu-runtime-tab': 'apps' }, header, alwaysCard, denyCard, floorCard);
    },
};
			},
			"settings/tabs/behavior.js": function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.tab = exports.ACTIVATION_DEFAULT = exports.ACTIVATION_CHOICES = exports.IME_POLICIES = void 0;
exports.buildBehaviorView = buildBehaviorView;
exports.IME_POLICIES = ['leave', 'ask', 'takeover'];
exports.ACTIVATION_CHOICES = [null, 'ax_frontmost', 'ax_raise'];
exports.ACTIVATION_DEFAULT = 'default';
const isStrings = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string');
function switchControl(t, behavior, field, pending, key, lock) {
    const value = behavior[field];
    const checked = typeof value === 'boolean' ? value : null;
    return {
        field, label: t(`settings.field.behavior.${field}`), note: t(`settings.behavior.${key}Note`), lock, checked,
        enabled: !pending && checked !== null,
        toOn: { kind: 'behavior.set', field, value: true },
        toOff: { kind: 'behavior.set', field, value: false },
    };
}
function previewView(t, preview, pending) {
    const changes = isStrings(preview.changes) ? preview.changes : [];
    const loosened = isStrings(preview.loosened) ? preview.loosened : [];
    const counted = typeof preview.changes_count === 'number' && Number.isFinite(preview.changes_count)
        ? Math.max(preview.changes_count, changes.length) : changes.length;
    return {
        key: JSON.stringify(preview),
        title: t('settings.behavior.importTitle'),
        changes,
        changesText: counted === 0 ? t('settings.behavior.importNoChanges') : t('settings.behavior.importChanges', { count: counted }),
        more: counted > changes.length ? t('settings.behavior.importMore', { shown: changes.length, count: counted }) : null,
        loosened,
        loosenedText: loosened.length === 0 ? t('settings.behavior.importNothingLoosened') : t('settings.behavior.importLoosens'),
        directoryIgnored: preview.log_directory_ignored === true ? t('settings.behavior.importDirectoryIgnored') : null,
        confirm: { label: loosened.length === 0 ? t('settings.behavior.apply') : t('settings.behavior.applyVerified'), enabled: !pending,
            action: 'import_confirm' },
        leave: t('settings.behavior.importLeave'),
    };
}
function buildBehaviorView(snapshot, { t, pending }) {
    const behavior = snapshot?.behavior ?? {};
    const held = pending || snapshot === null;
    const ime = behavior.ime_policy_cap;
    const imeValue = typeof ime === 'string' && exports.IME_POLICIES.includes(ime) ? ime : null;
    const electron = behavior.electron_ax_auto;
    const electronValue = electron === true ? 'auto' : electron === false ? 'off' : null;
    const activation = behavior.activation_method;
    const activationValue = activation === null || activation === undefined ? exports.ACTIVATION_DEFAULT
        : activation === 'running_application' || activation === 'ax_frontmost' || activation === 'ax_raise' ? activation : null;
    const activationOptions = exports.ACTIVATION_CHOICES.map((m) => ({
        value: m ?? exports.ACTIVATION_DEFAULT,
        label: m === null ? t('settings.value.activation_method.default') : t(`settings.value.activation_method.${m}`),
        change: { kind: 'behavior.set', field: 'activation_method', value: m },
    }));
    if (activationValue === 'running_application') {
        activationOptions.splice(1, 0, { value: 'running_application', label: t('settings.behavior.activationExplicit'),
            change: { kind: 'behavior.set', field: 'activation_method', value: 'running_application' } });
    }
    const preview = snapshot?.import_preview ?? null;
    return {
        title: t('settings.behavior.title'),
        note: t('settings.behavior.note'),
        ready: snapshot !== null,
        unknown: t('settings.behavior.unknownValue'),
        operation: {
            title: t('settings.behavior.operation'),
            restoreFocus: switchControl(t, behavior, 'restore_focus_on_turn_end', held, 'restoreFocus', null),
            pointTargets: switchControl(t, behavior, 'allow_point_targets', held, 'pointTargets', t('settings.behavior.pointTargetsLock')),
            imePolicy: {
                id: 'cu-runtime-behavior-ime', label: t('settings.field.behavior.ime_policy_cap'), note: t('settings.behavior.imePolicyNote'),
                lock: t('settings.behavior.imePolicyLock'), value: imeValue, enabled: !held && imeValue !== null,
                options: exports.IME_POLICIES.map((p) => ({ value: p, label: t(`settings.value.ime_policy_cap.${p}`),
                    change: { kind: 'behavior.set', field: 'ime_policy_cap', value: p } })),
            },
            electronAX: {
                id: 'cu-runtime-behavior-electron', label: t('settings.field.behavior.electron_ax_auto'), note: t('settings.behavior.electronAXNote'),
                lock: t('settings.behavior.electronAXLock'), value: electronValue, enabled: !held && electronValue !== null,
                options: [
                    { value: 'auto', label: t('settings.behavior.auto'), change: { kind: 'behavior.set', field: 'electron_ax_auto', value: true } },
                    { value: 'off', label: t('settings.behavior.off'), change: { kind: 'behavior.set', field: 'electron_ax_auto', value: false } },
                ],
            },
        },
        advanced: {
            title: t('settings.behavior.advanced'),
            activation: {
                id: 'cu-runtime-behavior-activation', label: t('settings.field.behavior.activation_method'),
                note: t('settings.behavior.activationNote'), lock: null, value: activationValue,
                enabled: !held && activationValue !== null, options: activationOptions,
            },
            importExport: {
                title: t('settings.behavior.importExport'), note: t('settings.behavior.importExportNote'),
                import: { label: t('settings.behavior.import'), enabled: !held, action: 'import' },
                export: { label: t('settings.behavior.export'), enabled: !held, action: 'export_settings' },
            },
            reset: {
                title: t('settings.behavior.reset'), note: t('settings.behavior.resetNote'), lock: t('settings.behavior.resetLock'),
                label: t('settings.behavior.resetButton'), enabled: !held, change: { kind: 'reset' },
                confirm: { title: t('settings.behavior.reset'), text: t('settings.behavior.resetNote'), confirmLabel: t('settings.behavior.resetConfirm') },
            },
        },
        importPreview: preview === null ? null : previewView(t, preview, held),
    };
}
exports.tab = {
    id: 'behavior',
    render(props, ui) {
        const { h, styles } = ui;
        const [confirmReset, setConfirmReset] = ui.useState(false);
        const [left, setLeft] = ui.useState(null);
        const view = buildBehaviorView(props.snapshot, props);
        const header = h('div', { key: 'header', style: { display: 'grid', gap: 2 } }, h('h3', { style: { ...styles.heading, fontSize: 15 } }, view.title), h('p', { style: styles.note }, view.note));
        if (!view.ready)
            return h('div', { style: styles.tab, 'data-cu-runtime-tab': 'behavior' }, header);
        const text = (key, note, lock) => h('div', { key, style: { flex: '1 1 220px', minWidth: 0, display: 'grid', gap: 2 } }, h('p', { style: styles.note }, note), lock === null ? null : h('p', { style: styles.quiet }, lock));
        const settingRow = (key, label, note, lock, known, control) => h('div', { key, style: { display: 'grid', gap: 4 }, 'data-behavior': key }, h('div', { style: styles.row }, h('span', { style: { ...styles.heading, flex: '1 1 160px', minWidth: 0 } }, label), control), text('text', note, lock), known ? null : h('p', { style: styles.warn }, view.unknown));
        const switchRow = (c) => settingRow(c.field, c.label, c.note, c.lock, c.checked !== null, ui.switch({ key: 'switch', label: c.label, checked: c.checked === true, disabled: !c.enabled,
            onChange: (next) => { if (next !== c.checked)
                void props.apply(next ? c.toOn : c.toOff); } }));
        const choiceRow = (key, c) => settingRow(key, c.label, c.note, c.lock, c.value !== null, ui.segmented({ key: 'choice', id: c.id, label: c.label, value: c.value ?? '', disabled: !c.enabled,
            options: c.options.map((o) => ({ value: o.value, label: o.label })),
            onChange: (next) => {
                const option = c.options.find((o) => o.value === next);
                if (option !== undefined && next !== c.value)
                    void props.apply(option.change);
            } }));
        const o = view.operation;
        const operation = ui.card({
            key: 'operation', title: o.title,
            children: [switchRow(o.restoreFocus), switchRow(o.pointTargets), choiceRow('ime_policy_cap', o.imePolicy),
                choiceRow('electron_ax_auto', o.electronAX)],
        });
        const a = view.advanced;
        const io = a.importExport;
        const r = a.reset;
        const advanced = ui.card({
            key: 'advanced', title: a.title,
            children: [
                choiceRow('activation_method', a.activation),
                h('div', { key: 'importExport', style: { display: 'grid', gap: 4 }, 'data-behavior': 'importExport' }, h('div', { style: styles.row }, h('span', { style: { ...styles.heading, flex: '1 1 160px', minWidth: 0 } }, io.title), h('div', { style: styles.actions }, ui.button({ key: 'import', label: io.import.label, disabled: !io.import.enabled,
                    onClick: () => { setLeft(null); void props.action(io.import.action); } }), ui.button({ key: 'export', label: io.export.label, disabled: !io.export.enabled,
                    onClick: () => void props.action(io.export.action) }))), text('text', io.note, null)),
                h('div', { key: 'reset', style: { display: 'grid', gap: 4 }, 'data-behavior': 'reset' }, h('div', { style: styles.row }, h('span', { style: { ...styles.heading, flex: '1 1 160px', minWidth: 0 } }, r.title), ui.button({ key: 'reset', label: r.label, disabled: !r.enabled, onClick: () => setConfirmReset(true) })), text('text', r.note, r.lock)),
            ],
        });
        const p = view.importPreview;
        const preview = p === null || p.key === left ? null : ui.card({
            key: 'importPreview', title: p.title, note: p.changesText,
            children: [
                p.changes.length === 0 ? null : ui.list({ key: 'changes', label: p.changesText, empty: p.changesText, maxHeight: 200,
                    rows: p.changes.map((c, i) => h('code', { key: `${i}:${c}`, style: styles.code }, c)) }),
                p.more === null ? null : h('p', { key: 'more', style: styles.quiet }, p.more),
                h('p', { key: 'loosenedText', style: p.loosened.length === 0 ? styles.note : styles.warn }, p.loosenedText),
                p.loosened.length === 0 ? null : ui.list({ key: 'loosened', label: p.loosenedText, empty: p.loosenedText, maxHeight: 200,
                    rows: p.loosened.map((c, i) => h('code', { key: `${i}:${c}`, style: styles.code }, c)) }),
                p.directoryIgnored === null ? null : h('p', { key: 'directory', style: styles.quiet }, p.directoryIgnored),
                h('div', { key: 'actions', style: styles.actions }, ui.button({ key: 'leave', label: p.leave, variant: 'ghost', onClick: () => setLeft(p.key) }), ui.button({ key: 'confirm', label: p.confirm.label, variant: 'primary', disabled: !p.confirm.enabled,
                    onClick: () => void props.action(p.confirm.action) })),
            ],
        });
        const confirm = ui.confirm({
            open: confirmReset, title: r.confirm.title, text: r.confirm.text, confirmLabel: r.confirm.confirmLabel,
            onCancel: () => setConfirmReset(false),
            onConfirm: () => {
                setConfirmReset(false);
                if (r.enabled)
                    void props.apply(r.change);
            },
        });
        return h('div', { style: styles.tab, 'data-cu-runtime-tab': 'behavior' }, header, operation, advanced, preview, confirm);
    },
};
			},
			"settings/tabs/index.js": function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TAB_MODULES = void 0;
const access_ts_1 = require("./access.js");
const apps_ts_1 = require("./apps.js");
const behavior_ts_1 = require("./behavior.js");
const logs_ts_1 = require("./logs.js");
const overview_ts_1 = require("./overview.js");
const privacy_ts_1 = require("./privacy.js");
const shortcuts_ts_1 = require("./shortcuts.js");
exports.TAB_MODULES = { overview: overview_ts_1.tab, access: access_ts_1.tab, apps: apps_ts_1.tab, shortcuts: shortcuts_ts_1.tab, privacy: privacy_ts_1.tab, behavior: behavior_ts_1.tab, logs: logs_ts_1.tab };
			},
			"settings/tabs/logs.js": function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.tab = exports.CHANGE_METHODS = exports.RETENTION_DAYS = void 0;
exports.changeTime = changeTime;
exports.sizeText = sizeText;
exports.changeText = changeText;
exports.buildLogsView = buildLogsView;
const model_ts_1 = require("../model.js");
exports.RETENTION_DAYS = [7, 30, 90];
exports.CHANGE_METHODS = {
    'settings.denylist_add': 'denylistAdd', 'settings.denylist_remove': 'denylistRemove',
    'settings.persistent_add': 'persistentAdd', 'settings.persistent_revoke': 'persistentRevoke',
    'settings.persistent_mode': 'persistentMode', 'settings.persistent_reapprove': 'persistentReapprove',
    'settings.access': 'access', 'settings.privacy': 'privacy',
    'settings.chord_disable': 'chordDisable', 'settings.chord_enable': 'chordEnable', 'settings.chord_add': 'chordAdd',
    'settings.chord_remove': 'chordRemove', 'settings.revoke': 'revoke', 'settings.revoke_all': 'revokeAll',
    'settings.behavior': 'behavior', 'settings.import': 'import', 'settings.reset': 'reset',
    'settings.audit_export': 'auditExport', 'settings.logs': 'logs', 'settings.export': 'export',
    'settings.stop': 'stop', 'settings.restart': 'restart',
};
const WITH_APP = new Set(['denylistAdd', 'denylistRemove', 'persistentAdd', 'persistentRevoke', 'persistentMode', 'persistentReapprove']);
const pad = (n) => String(n).padStart(2, '0');
const isCount = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
function changeTime(at) {
    const d = new Date(at * 1000);
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function sizeText(t, bytes) {
    if (bytes < 1000)
        return t('settings.logs.bytes', { n: Math.round(bytes) });
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1000;
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) {
        value /= 1000;
        unit += 1;
    }
    const shown = unit === 0 ? String(Math.round(value)) : String(Math.round(value * 10) / 10);
    return `${shown} ${units[unit]}`;
}
function changeText(t, c, snapshot) {
    const word = exports.CHANGE_METHODS[c.method];
    if (word === undefined)
        return c.method;
    const app = c.app === null ? t('settings.logs.unknownApp') : t('settings.logs.app', { name: (0, model_ts_1.appName)(snapshot, c.app) ?? c.app });
    if (word === 'chordAdd' && c.app !== null)
        return t('settings.logs.change.chordAddApp', { app });
    return WITH_APP.has(word) ? t(`settings.logs.change.${word}`, { app }) : t(`settings.logs.change.${word}`);
}
function buildLogsView(snapshot, { t, pending }) {
    const logs = snapshot?.logs ?? {};
    const held = pending || snapshot === null;
    const directory = typeof logs.directory === 'string' && logs.directory !== '' ? logs.directory : null;
    const custom = logs.directory_custom === true || directory !== null;
    const days = logs.retention_days;
    const retention = exports.RETENTION_DAYS.includes(days) ? String(days) : null;
    const files = isCount(logs.files) && isCount(logs.bytes)
        ? t('settings.logs.fileCount', { n: logs.files, size: sizeText(t, logs.bytes) }) : t('settings.value.none');
    return {
        title: t('settings.logs.title'),
        note: t('settings.logs.note'),
        ready: snapshot !== null,
        auditLog: {
            title: t('settings.logs.auditLog'),
            location: {
                title: t('settings.logs.location'),
                path: directory ?? (custom ? t('settings.logs.customLocation') : t('settings.logs.defaultLocation')),
                defaultTag: custom ? null : t('settings.logs.defaultTag'),
                note: t('settings.logs.locationNote'),
                choose: { label: t('settings.logs.choose'), enabled: !held, action: 'choose_log_directory' },
                useDefault: custom ? { label: t('settings.logs.useDefault'), enabled: !held, action: 'use_default_log_directory' } : null,
                reveal: { label: t('settings.logs.reveal'), enabled: !held, action: 'reveal_log' },
            },
            retention: {
                id: 'cu-runtime-logs-retention',
                title: t('settings.logs.retention'),
                note: t('settings.logs.retentionNote'),
                lock: t('settings.logs.retentionLock'),
                value: retention,
                enabled: !held && retention !== null,
                options: exports.RETENTION_DAYS.map((n) => ({ value: String(n), label: t('settings.unit.days', { n }),
                    change: { kind: 'logs.retention', days: n } })),
            },
            files: { title: t('settings.logs.files'), text: files,
                export: { label: t('settings.logs.export'), enabled: !held, action: 'export_audit' } },
            recorded: { title: t('settings.logs.recorded'), note: t('settings.logs.recordedNote'), fixed: t('settings.logs.fixed') },
        },
        changes: {
            title: t('settings.logs.recentChanges'),
            rows: (snapshot?.recent_changes ?? []).map((c, i) => ({
                key: `${c.at}:${i}`, at: changeTime(c.at), text: changeText(t, c, snapshot),
                reason: c.reason, verified: c.verified === true ? t('settings.logs.verified') : null,
            })),
            empty: t('settings.logs.noChanges'),
            maxHeight: 320,
        },
    };
}
exports.tab = {
    id: 'logs',
    render(props, ui) {
        const { h, styles } = ui;
        const view = buildLogsView(props.snapshot, props);
        const header = h('div', { key: 'header', style: { display: 'grid', gap: 2 } }, h('h3', { style: { ...styles.heading, fontSize: 15 } }, view.title), h('p', { style: styles.note }, view.note));
        if (!view.ready)
            return h('div', { style: styles.tab, 'data-cu-runtime-tab': 'logs' }, header);
        const run = (key, c, variant) => ui.button({ key, label: c.label, disabled: !c.enabled, variant, onClick: () => void props.action(c.action) });
        const title = (text) => h('span', { style: { ...styles.heading, flex: '1 1 160px', minWidth: 0 } }, text);
        const a = view.auditLog;
        const l = a.location;
        const r = a.retention;
        const f = a.files;
        const rec = a.recorded;
        const audit = ui.card({
            key: 'auditLog', title: a.title,
            children: [
                h('div', { key: 'location', style: { display: 'grid', gap: 4 }, 'data-logs': 'location' }, h('div', { style: styles.row }, h('span', { style: { ...styles.line, flex: '1 1 160px', minWidth: 0 } }, h('span', { style: styles.heading }, l.title), l.defaultTag === null ? null : ui.tag(l.defaultTag, 'quiet')), h('div', { style: styles.actions }, run('reveal', l.reveal), run('choose', l.choose), l.useDefault === null ? null : run('useDefault', l.useDefault, 'ghost'))), h('code', { style: { ...styles.code, overflowWrap: 'anywhere' } }, l.path), h('p', { style: styles.note }, l.note)),
                h('div', { key: 'retention', style: { display: 'grid', gap: 4 }, 'data-logs': 'retention' }, h('div', { style: styles.row }, title(r.title), ui.segmented({ key: 'choice', id: r.id, label: r.title, value: r.value ?? '', disabled: !r.enabled,
                    options: r.options.map((o) => ({ value: o.value, label: o.label })),
                    onChange: (next) => {
                        const option = r.options.find((o) => o.value === next);
                        if (option !== undefined && next !== r.value)
                            void props.apply(option.change);
                    } })), h('p', { style: styles.note }, r.note), h('p', { style: styles.quiet }, r.lock)),
                h('div', { key: 'files', style: { display: 'grid', gap: 4 }, 'data-logs': 'files' }, h('div', { style: styles.row }, title(f.title), run('export', f.export)), h('p', { style: styles.note }, f.text)),
                h('div', { key: 'recorded', style: { display: 'grid', gap: 4 }, 'data-logs': 'recorded' }, h('div', { style: styles.row }, title(rec.title), ui.tag(rec.fixed, 'quiet')), h('p', { style: styles.note }, rec.note)),
            ],
        });
        const c = view.changes;
        const changes = ui.card({
            key: 'changes', title: c.title,
            children: [ui.list({
                    key: 'list', label: c.title, empty: c.empty, maxHeight: c.maxHeight,
                    rows: c.rows.map((row) => h('div', { key: row.key, style: styles.row, 'data-change': row.key }, h('code', { style: { ...styles.code, flex: 'none' } }, row.at), h('span', { style: { flex: '1 1 160px', minWidth: 0 } }, row.text), row.reason === null ? null : h('code', { style: { ...styles.code, color: 'var(--dsw-alias-label-secondary)' } }, row.reason), row.verified === null ? null : ui.tag(row.verified, 'info'))),
                })],
        });
        return h('div', { style: styles.tab, 'data-cu-runtime-tab': 'logs' }, header, audit, changes);
    },
};
			},
			"settings/tabs/overview.js": function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.tab = exports.REFUSAL_REASONS = void 0;
exports.refusalTime = refusalTime;
exports.buildOverviewView = buildOverviewView;
const model_ts_1 = require("../model.js");
exports.REFUSAL_REASONS = {
    hard_denied: 'floor', hard_denied_frontmost: 'floor', user_denied: 'denyList', dsh_host_app: 'dshHost',
    chord_not_allowed: 'chord', invalid_chord: 'chord', not_granted: 'noGrant', no_grant: 'noGrant', grant_expired: 'noGrant',
    action_not_allowed: 'mode', click_not_allowed: 'mode', ax_action_not_allowed: 'mode', launch_not_allowed: 'mode',
    approval_rejected: 'refusedByUser', approval_refused_earlier: 'refusedByUser', approval_limit: 'dialogLimit',
    approval_timeout: 'dialogTimeout', secure_input: 'secureInput', hit_test_failed: 'outsideWindow',
    not_on_target_window: 'outsideWindow', not_on_granted_window: 'outsideWindow', open_not_allowed: 'notOpenable',
    open_not_found: 'notOpenable', ime_switch_needs_approval: 'imeSwitch', finder_not_enabled: 'finder',
    session_locked: 'locked',
};
const ATTEMPTS = ['access.request', 'apps.launch', 'act.key', 'act.type', 'act.click', 'act.menu', 'observe', 'apps.list'];
const DEFAULT_MODES = ['ask', 'read', 'full'];
const pad = (n) => String(n).padStart(2, '0');
function refusalTime(t, at, now) {
    const d = new Date(at * 1000);
    const today = new Date(now);
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
    return sameDay ? time : t('settings.overview.yesterday', { time });
}
function lasts(t, a, now) {
    if (a.scope === 'turn' || a.scope === 'always')
        return t(`settings.overview.scope.${a.scope}`);
    const scope = a.scope === 'session' ? t('settings.overview.scope.session') : t('settings.overview.configGrant');
    const seconds = Math.max(0, a.expires_at - now / 1000);
    return seconds < 60 ? t('settings.overview.lastsUnderMinute', { scope })
        : t('settings.overview.lastsLeft', { scope, minutes: Math.floor(seconds / 60) });
}
function modeChip(t, mode) {
    if (mode === 'read')
        return { text: t('settings.mode.read'), tone: 'info' };
    if (mode === 'full')
        return { text: t('settings.mode.full'), tone: 'warning' };
    return { text: t('settings.overview.configGrant'), tone: 'neutral' };
}
function refusalRow(t, r, i, snapshot, now) {
    const app = r.app === null ? t('settings.overview.unknownApp') : t('settings.overview.app', { name: (0, model_ts_1.appName)(snapshot, r.app) ?? r.app });
    const method = r.method === 'zoom' ? 'observe' : r.method;
    const text = ATTEMPTS.includes(method) ? t(`settings.overview.attempt.${method}`, { app })
        : t('settings.overview.attempt.other', { method: r.method, app });
    const word = exports.REFUSAL_REASONS[r.reason];
    return { key: `${r.at}:${i}`, at: refusalTime(t, r.at, now), text, reason: word === undefined ? r.reason : t(`settings.overview.reason.${word}`), code: r.reason };
}
function permissionRow(t, id, granted) {
    const state = granted === null ? 'notRequested' : granted ? 'granted' : 'missing';
    return { id, label: t(`settings.overview.permission.${id}`), state, text: t(`settings.overview.permission.${state}`),
        dot: state === 'granted' ? 'done' : state === 'missing' ? 'error' : 'idle' };
}
function buildOverviewView(snapshot, { t, pending, now }) {
    const permissions = snapshot?.permissions ?? null;
    const mode = snapshot !== null && typeof snapshot.access.default_mode === 'string' && DEFAULT_MODES.includes(snapshot.access.default_mode)
        ? snapshot.access.default_mode : 'ask';
    const modeName = t(`settings.value.default_mode.${mode}`);
    const grants = snapshot?.grants ?? [];
    return {
        title: t('settings.overview.title'),
        note: t('settings.overview.note'),
        ready: snapshot !== null,
        permissions: {
            title: t('settings.overview.permissions'),
            rows: permissions === null ? null : [
                permissionRow(t, 'accessibility', permissions.accessibility),
                permissionRow(t, 'screen_recording', permissions.screen_recording),
                permissionRow(t, 'input_monitoring', permissions.input_monitoring),
            ],
            unknown: permissions === null ? t('settings.overview.permissionsUnknown') : null,
            note: t('settings.overview.inputMonitoringNote'),
            hint: t('settings.overview.permissionsHint'),
            toDaemon: t('settings.toDaemon'),
        },
        newSession: {
            title: t('settings.overview.newSessionDefault'),
            mode: modeName,
            note: mode === 'ask' ? t('settings.overview.newSessionNote') : t('settings.overview.newSessionGranted', { mode: modeName }),
            edit: t('settings.overview.editDefaults'),
        },
        grants: {
            title: t('settings.overview.activeGrants'),
            rows: grants.flatMap((g) => g.apps.map((a) => ({
                key: `${g.task_id}:${a.bundle_id}`,
                app: { bundle_id: a.bundle_id, name: a.name },
                mode: modeChip(t, a.mode),
                lasts: lasts(t, a, now),
                source: g.by_dialog ? t('settings.overview.byDialog') : t('settings.overview.configGrant'),
                session: g.owner_gone ? t('settings.overview.processGone') : t('settings.overview.session', { task: (0, model_ts_1.shortTask)(g.task_id) }),
                ownerGone: g.owner_gone,
                revoke: { label: t('settings.overview.revoke'), enabled: !pending, change: { kind: 'revoke', task_id: g.task_id } },
            }))),
            empty: t('settings.overview.noneActive'),
            revokeAll: { label: t('settings.overview.revokeAll'), enabled: !pending && grants.length > 0, change: { kind: 'revoke_all' } },
        },
        refusals: {
            title: t('settings.overview.recentRefusals'),
            note: t('settings.overview.refusalsNote'),
            rows: snapshot === null ? [] : snapshot.recent_refusals.map((r, i) => refusalRow(t, r, i, snapshot, now)),
            empty: t('settings.overview.noRefusals'),
        },
    };
}
exports.tab = {
    id: 'overview',
    render(props, ui) {
        const { h, styles } = ui;
        const view = buildOverviewView(props.snapshot, props);
        const header = h('div', { key: 'header', style: { display: 'grid', gap: 2 } }, h('h3', { style: { ...styles.heading, fontSize: 15 } }, view.title), h('p', { style: styles.note }, view.note));
        if (!view.ready)
            return h('div', { style: styles.tab, 'data-cu-runtime-tab': 'overview' }, header);
        const p = view.permissions;
        const permissions = ui.card({
            key: 'permissions', title: p.title,
            children: [
                p.rows === null ? h('p', { key: 'unknown', style: styles.quiet }, p.unknown)
                    : h('dl', { key: 'rows', style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) max-content', rowGap: 6, columnGap: 12, margin: 0 } }, ...p.rows.flatMap((r) => [
                        h('dt', { key: `${r.id}:label` }, r.label),
                        h('dd', { key: `${r.id}:value`, style: { ...styles.line, margin: 0 }, 'data-permission': r.id, 'data-state': r.state }, ui.dot(r.dot), h('span', null, r.text)),
                    ])),
                h('p', { key: 'note', style: styles.note }, p.note),
                h('div', { key: 'hint', style: styles.row }, h('p', { style: styles.note }, p.hint), ui.button({ key: 'toDaemon', label: p.toDaemon, onClick: () => props.goTo('daemon'), variant: 'ghost' })),
            ],
        });
        const n = view.newSession;
        const newSession = ui.card({
            key: 'newSession', title: n.title,
            children: [
                h('p', { key: 'mode', style: { ...styles.heading, fontSize: 15 } }, n.mode),
                h('p', { key: 'note', style: styles.note }, n.note),
                h('div', { key: 'edit', style: styles.actions }, ui.button({ key: 'edit', label: n.edit, onClick: () => props.goTo('access'), variant: 'ghost' })),
            ],
        });
        const g = view.grants;
        const grants = ui.card({
            key: 'grants', title: g.title,
            trailing: ui.button({ key: 'revokeAll', label: g.revokeAll.label, disabled: !g.revokeAll.enabled,
                onClick: () => void props.apply(g.revokeAll.change) }),
            children: [ui.list({
                    key: 'list', label: g.title, empty: g.empty,
                    rows: g.rows.map((r) => h('div', { key: r.key, style: { ...styles.row, opacity: r.ownerGone ? 0.55 : 1 }, 'data-grant': r.key }, h('div', { style: { flex: '1 1 160px', minWidth: 0 } }, ui.appLabel(r.app)), ui.tag(r.mode.text, r.mode.tone), h('span', { style: { fontSize: 12 } }, r.lasts), h('span', { style: { display: 'grid', fontSize: 12 } }, h('span', { style: styles.quiet }, r.source), h('span', { style: r.ownerGone ? { ...styles.error, fontWeight: 600 } : styles.code }, r.session)), ui.button({ key: 'revoke', label: r.revoke.label, disabled: !r.revoke.enabled, onClick: () => void props.apply(r.revoke.change) }))),
                })],
        });
        const f = view.refusals;
        const refusals = ui.card({
            key: 'refusals', title: f.title, note: f.note,
            children: [ui.list({
                    key: 'list', label: f.title, empty: f.empty,
                    rows: f.rows.map((r) => h('div', { key: r.key, style: styles.row, 'data-refusal': r.code }, h('code', { style: { ...styles.code, flex: 'none' } }, r.at), h('span', { style: { flex: '1 1 160px', minWidth: 0 } }, r.text), ui.tag(r.reason, 'danger'), h('code', { style: { ...styles.code, color: 'var(--dsw-alias-label-secondary)' } }, r.code))),
                })],
        });
        return h('div', { style: styles.tab, 'data-cu-runtime-tab': 'overview' }, header, h('div', { key: 'cards', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 } }, permissions, newSession), grants, refusals);
    },
};
			},
			"settings/tabs/privacy.js": function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.tab = exports.PRIVACY_FIELDS = void 0;
exports.pickedForTextOnly = pickedForTextOnly;
exports.buildPrivacyView = buildPrivacyView;
const model_ts_1 = require("../model.js");
exports.PRIVACY_FIELDS = ['send_screenshots', 'send_ax_text', 'send_ocr', 'send_zoom'];
function textOnlyApps(snapshot) {
    const v = snapshot?.privacy.text_only_apps;
    return Array.isArray(v) ? v.filter((id) => typeof id === 'string' && id !== '') : [];
}
function switchRow(snapshot, field, title, note, enabled) {
    const v = snapshot?.privacy[field];
    const known = typeof v === 'boolean';
    const checked = v === true;
    const change = field === 'clear_clipboard_on_turn_start' ? { kind: 'clipboard.set', on: !checked }
        : { kind: 'privacy.set', field, on: !checked };
    return { field, title, note, checked, known, enabled: enabled && known, change };
}
function pickedForTextOnly(snapshot, since) {
    if (snapshot === null || since === null || snapshot.picked_app === null)
        return null;
    const o = snapshot.last_outcome;
    return o !== null && o.kind === 'choose_app' && o.outcome === 'done' && o.at >= since / 1000 - 1 ? snapshot.picked_app : null;
}
function buildPrivacyView(snapshot, { t, pending, pickSince = null }) {
    const enabled = !pending && snapshot !== null;
    const listed = textOnlyApps(snapshot);
    const named = (id) => ({ bundle_id: id, name: (0, model_ts_1.appName)(snapshot, id) });
    const picked = pickedForTextOnly(snapshot, pickSince);
    const isListed = picked !== null && listed.some((id) => id.toLowerCase() === picked.bundle_id.toLowerCase());
    return {
        title: t('settings.privacy.title'),
        note: t('settings.privacy.note'),
        ready: snapshot !== null,
        sent: {
            title: t('settings.privacy.sent.title'),
            lock: t('settings.privacy.sent.lock'),
            switches: exports.PRIVACY_FIELDS.map((f) => switchRow(snapshot, f, t(`settings.field.privacy.${f}`), t(`settings.privacy.${f}.note`), enabled)),
        },
        textOnly: {
            title: t('settings.privacy.textOnly.title'),
            note: t('settings.privacy.textOnly.note'),
            add: { label: t('settings.privacy.textOnly.add'), enabled },
            rows: listed.map((id, i) => ({
                key: `${i}:${id}`,
                app: named(id),
                remove: { label: t('settings.privacy.textOnly.remove'), enabled, change: { kind: 'text_only.remove', bundle_id: id } },
            })),
            empty: t('settings.privacy.textOnly.empty'),
            picked: picked === null ? null : {
                app: { bundle_id: picked.bundle_id, name: picked.name ?? (0, model_ts_1.appName)(snapshot, picked.bundle_id) },
                text: t('settings.privacy.textOnly.picked'),
                listed: isListed,
                listedText: t('settings.privacy.textOnly.listed'),
                add: { label: t('settings.privacy.textOnly.addPicked'), enabled: enabled && !isListed,
                    change: { kind: 'text_only.add', bundle_id: picked.bundle_id } },
                dismiss: t('settings.privacy.textOnly.dismiss'),
            },
        },
        clipboard: {
            title: t('settings.privacy.clipboard.title'),
            switch: switchRow(snapshot, 'clear_clipboard_on_turn_start', t('settings.privacy.clipboard.label'), t('settings.privacy.clipboard.note'), enabled),
        },
    };
}
exports.tab = {
    id: 'privacy',
    render(props, ui) {
        const { h, styles } = ui;
        const [pickSince, setPickSince] = ui.useState(null);
        const view = buildPrivacyView(props.snapshot, { t: props.t, pending: props.pending, pickSince });
        const header = h('div', { key: 'header', style: { display: 'grid', gap: 2 } }, h('h3', { style: { ...styles.heading, fontSize: 15 } }, view.title), h('p', { style: styles.note }, view.note));
        if (!view.ready)
            return h('div', { style: styles.tab, 'data-cu-runtime-tab': 'privacy' }, header);
        const setting = (key, title, note, control, extra = {}) => h('div', { key, style: { ...styles.row, alignItems: 'flex-start' }, ...extra }, h('div', { style: { display: 'grid', gap: 2, flex: '1 1 240px', minWidth: 0 } }, h('span', { style: styles.heading }, title), h('p', { style: styles.note }, note)), control);
        const switchNode = (s) => setting(s.field, s.title, s.note, ui.switch({
            key: 'switch', label: s.title, checked: s.checked, disabled: !s.enabled,
            onChange: (next) => { if (s.enabled && next !== s.checked)
                void props.apply(s.change); },
        }), { 'data-privacy-field': s.field });
        const o = view.textOnly;
        const p = o.picked;
        const picked = p === null ? null : h('div', { key: 'picked', style: styles.row, 'data-picked-app': p.app.bundle_id }, h('div', { style: { display: 'grid', gap: 2, flex: '1 1 200px', minWidth: 0 } }, h('p', { style: styles.note }, p.text), ui.appLabel(p.app), p.listed ? h('p', { style: styles.quiet }, p.listedText) : null), h('div', { style: styles.actions }, ui.button({ key: 'dismiss', label: p.dismiss, onClick: () => setPickSince(null), variant: 'ghost' }), ui.button({ key: 'addPicked', label: p.add.label, disabled: !p.add.enabled, variant: 'primary',
            onClick: () => void props.apply(p.add.change).then((ok) => { if (ok)
                setPickSince(null); }) })));
        const textOnly = h('div', { key: 'textOnly', style: { display: 'grid', gap: 8 }, 'data-privacy-field': 'text_only_apps' }, setting('head', o.title, o.note, ui.button({ key: 'add', label: o.add.label, disabled: !o.add.enabled,
            onClick: () => {
                const clicked = Date.now();
                void props.action('choose_app').then((ok) => { if (ok)
                    setPickSince(clicked); });
            } })), picked, ui.list({
            key: 'list', label: o.title, empty: o.empty,
            rows: o.rows.map((r) => h('div', { key: r.key, style: styles.row, 'data-text-only': r.app.bundle_id }, h('div', { style: { flex: '1 1 160px', minWidth: 0 } }, ui.appLabel(r.app)), ui.button({ key: 'remove', label: r.remove.label, disabled: !r.remove.enabled, onClick: () => void props.apply(r.remove.change) }))),
        }));
        const s = view.sent;
        const sent = ui.card({
            key: 'sent', title: s.title,
            trailing: h('span', { style: { ...styles.warn, fontSize: 11 }, 'data-lock': 'sent' }, s.lock),
            children: [...s.switches.map(switchNode), textOnly],
        });
        const clipboard = ui.card({ key: 'clipboard', title: view.clipboard.title, children: [switchNode(view.clipboard.switch)] });
        return h('div', { style: styles.tab, 'data-cu-runtime-tab': 'privacy' }, header, sent, clipboard);
    },
};
			},
			"settings/tabs/shortcuts.js": function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.tab = exports.EMPTY_CHORD_FORM = exports.NEVER_ORDER = exports.CHORD_LABELS = void 0;
exports.chordCaps = chordCaps;
exports.chordLabel = chordLabel;
exports.chordOf = chordOf;
exports.buildShortcutsView = buildShortcutsView;
const change_ts_1 = require("../change.js");
const model_ts_1 = require("../model.js");
const apps_ts_1 = require("./apps.js");
exports.CHORD_LABELS = [
    'cmd+a', 'cmd+c', 'cmd+v', 'cmd+x', 'cmd+z', 'shift+cmd+z', 'cmd+f', 'cmd+g', 'cmd+w', 'cmd+n', 'cmd+s', 'cmd+q',
    'cmd+delete', 'cmd+l', 'shift+cmd+t', 'cmd+b', 'cmd+i', 'cmd+u', 'shift+cmd+left', 'shift+cmd+right', 'shift+cmd+up',
    'shift+cmd+down', 'opt+shift+left', 'opt+shift+right', 'opt+left', 'opt+right', 'opt+up', 'opt+down', 'cmd+left',
    'cmd+right', 'cmd+up', 'cmd+down', 'ctrl+cmd+q', 'shift+cmd+q', 'opt+cmd+escape', 'cmd+space', 'ctrl+space', 'cmd+tab',
    'opt+cmd+h', 'shift+cmd+3', 'shift+cmd+4', 'shift+cmd+5', 'ctrl+up', 'ctrl+down', 'ctrl+left', 'ctrl+right',
    'opt+cmd+d', 'ctrl+f2',
];
exports.NEVER_ORDER = ['ctrl+cmd+q', 'shift+cmd+q', 'opt+cmd+escape', 'cmd+space', 'ctrl+space',
    'cmd+tab', 'opt+cmd+h', 'shift+cmd+3', 'shift+cmd+4', 'shift+cmd+5', 'ctrl+up', 'ctrl+down', 'ctrl+left', 'ctrl+right',
    'opt+cmd+d', 'ctrl+f2'];
const MODIFIERS = {
    cmd: 'cmd', command: 'cmd', super: 'cmd', meta: 'cmd', ctrl: 'ctrl', control: 'ctrl', opt: 'opt', option: 'opt',
    alt: 'opt', shift: 'shift', fn: 'fn', globe: 'fn',
};
const MODIFIER_ORDER = ['ctrl', 'opt', 'shift', 'cmd', 'fn'];
const MODIFIER_CAPS = { ctrl: '⌃', opt: '⌥', shift: '⇧', cmd: '⌘', fn: 'fn' };
const KEY_ALIASES = {
    enter: 'return', esc: 'escape', backspace: 'delete', pgup: 'pageup', pgdn: 'pagedown', arrowup: 'up', arrowdown: 'down',
    arrowleft: 'left', arrowright: 'right',
};
const KEY_CAPS = {
    return: '↩', tab: '⇥', space: 'Space', escape: '⎋', delete: '⌫', forwarddelete: '⌦', up: '↑', down: '↓', left: '←',
    right: '→', home: '↖', end: '↘', pageup: '⇞', pagedown: '⇟', minus: '-', equal: '=', comma: ',', period: '.',
    slash: '/', backslash: '\\', semicolon: ';', quote: "'", grave: '`', leftbracket: '[', rightbracket: ']',
};
function chordCaps(text) {
    const parts = text.toLowerCase().split('+').map((p) => p.trim());
    const mods = new Set();
    let key = null;
    for (const part of parts) {
        const mod = MODIFIERS[part];
        if (mod !== undefined) {
            mods.add(mod);
            continue;
        }
        if (part === '' || key !== null)
            return [text];
        key = KEY_ALIASES[part] ?? part;
    }
    if (key === null)
        return [text];
    return [...MODIFIER_ORDER.filter((m) => mods.has(m)).map((m) => MODIFIER_CAPS[m]), KEY_CAPS[key] ?? key.toUpperCase()];
}
function chordLabel(t, chord) {
    return exports.CHORD_LABELS.includes(chord) ? t(`settings.shortcuts.label.${chord}`) : null;
}
exports.EMPTY_CHORD_FORM = { chord: '', scope: 'all', app: '', note: '' };
const CONTROL = /[\p{Cc}\p{Cf}]/u;
function chordOf(text) {
    const chord = text.trim();
    return chord.length > 0 && chord.length <= change_ts_1.CHANGE_LIMITS.chord && !CONTROL.test(chord) ? chord : null;
}
function neverRank(chord) {
    const i = exports.NEVER_ORDER.indexOf(chord);
    return i === -1 ? exports.NEVER_ORDER.length : i;
}
function buildShortcutsView(snapshot, { t, pending, form = null, waiting = false }) {
    const chords = snapshot?.chords ?? { builtin: [], never: [], custom: [] };
    const chord = form === null ? null : chordOf(form.chord);
    const app = form === null || form.scope === 'all' ? null : (0, apps_ts_1.bundleIdOf)(form.app);
    const note = form === null ? null : (0, apps_ts_1.noteOf)(form.note);
    const ready = form !== null && chord !== null && note !== null && (form.scope === 'all' || app !== null);
    return {
        title: t('settings.shortcuts.title'),
        note: t('settings.shortcuts.note'),
        ready: snapshot !== null,
        builtin: {
            title: t('settings.shortcuts.builtin.title'),
            note: t('settings.shortcuts.builtin.note'),
            rows: chords.builtin.map((c) => ({
                key: c.chord,
                chord: c.chord,
                caps: chordCaps(c.chord),
                label: chordLabel(t, c.chord) ?? c.chord,
                on: c.enabled,
                toggle: { enabled: !pending, change: c.enabled ? { kind: 'chord.disable', chord: c.chord } : { kind: 'chord.enable', chord: c.chord } },
                off: c.enabled ? null : t('settings.shortcuts.builtin.off'),
            })),
            empty: t('settings.shortcuts.builtin.empty'),
        },
        custom: {
            title: t('settings.shortcuts.custom.title'),
            note: t('settings.shortcuts.custom.note'),
            add: { label: t('settings.shortcuts.custom.add'), enabled: !pending && form === null },
            rows: chords.custom.map((c, i) => {
                const name = c.app === null ? null : (0, model_ts_1.appName)(snapshot, c.app);
                return {
                    key: `${c.chord}:${c.app ?? '*'}:${i}`,
                    chord: c.chord,
                    caps: chordCaps(c.chord),
                    note: c.note === '' ? t('settings.value.none') : c.note,
                    hasNote: c.note !== '',
                    app: c.app === null ? null : { bundle_id: c.app, name },
                    scope: c.app === null ? t('settings.shortcuts.custom.everyApp') : t('settings.shortcuts.custom.onlyIn', { app: name ?? c.app }),
                    remove: { label: t('settings.shortcuts.custom.remove'), enabled: !pending, change: { kind: 'chord.remove', chord: c.chord, app: c.app } },
                };
            }),
            empty: t('settings.shortcuts.custom.empty'),
        },
        form: form === null ? null : {
            title: t('settings.shortcuts.form.title'),
            comboLabel: t('settings.shortcuts.form.combo'),
            chord: form.chord,
            caps: chord === null ? [] : chordCaps(chord),
            comboHint: t('settings.shortcuts.form.comboHint'),
            scopeLabel: t('settings.shortcuts.form.scope'),
            scope: form.scope,
            scopes: [{ value: 'all', label: t('settings.shortcuts.form.everyApp') }, { value: 'one', label: t('settings.shortcuts.form.oneApp') }],
            app: form.scope === 'all' ? null : {
                label: t('settings.shortcuts.form.bundleId'), value: form.app,
                chooseApp: { label: t('settings.shortcuts.form.chooseApp'), enabled: !pending && !waiting },
            },
            waiting: waiting ? t('settings.shortcuts.form.waiting') : null,
            stopWaiting: t('settings.shortcuts.form.stopWaiting'),
            noteLabel: t('settings.shortcuts.form.note'),
            note: form.note,
            notePlaceholder: t('settings.shortcuts.form.notePlaceholder'),
            cancel: t('settings.cancel'),
            submit: {
                label: t('settings.shortcuts.form.submit'), enabled: !pending && ready,
                change: { kind: 'chord.add', chord: chord ?? form.chord.trim(), app: form.scope === 'all' ? null : app ?? form.app.trim(), note: note ?? form.note.trim() },
            },
        },
        never: {
            title: t('settings.shortcuts.never.title'),
            note: t('settings.shortcuts.never.note'),
            rows: chords.never.map((c, i) => ({ c, i })).sort((a, b) => neverRank(a.c) - neverRank(b.c) || a.i - b.i)
                .map(({ c }) => ({ key: c, chord: c, caps: chordCaps(c), label: chordLabel(t, c) })),
            empty: t('settings.shortcuts.never.empty'),
            rules: [t('settings.shortcuts.never.fKeys'), t('settings.shortcuts.never.fnCombos')],
        },
    };
}
const FORM_STYLE = { display: 'grid', gap: 10, padding: 12, border: '.5px solid var(--dsw-alias-border-l4)', borderRadius: 10, minWidth: 0 };
exports.tab = {
    id: 'shortcuts',
    render(props, ui) {
        const { h, styles } = ui;
        const [form, setForm] = ui.useState(null);
        const [pick, setPick] = ui.useState(null);
        ui.useEffect(() => {
            if (pick === null)
                return;
            const result = (0, apps_ts_1.pickOutcome)(props.snapshot, pick);
            if (result.status === 'waiting')
                return;
            setPick(null);
            if (result.status === 'picked')
                setForm((f) => (f === null ? f : { ...f, scope: 'one', app: result.app.bundle_id }));
        }, [props.snapshot, pick]);
        const view = buildShortcutsView(props.snapshot, { t: props.t, pending: props.pending, form, waiting: pick !== null });
        const header = h('div', { key: 'header', style: { display: 'grid', gap: 2 } }, h('h3', { style: { ...styles.heading, fontSize: 15 } }, view.title), h('p', { style: styles.note }, view.note));
        if (!view.ready)
            return h('div', { style: styles.tab, 'data-cu-runtime-tab': 'shortcuts' }, header);
        const send = (change, done) => {
            void props.apply(change).then((ok) => { if (ok)
                done?.(); });
        };
        const edit = (patch) => setForm((f) => (f === null ? f : { ...f, ...patch }));
        const b = view.builtin;
        const builtin = ui.card({
            key: 'builtin', title: b.title, note: b.note,
            children: [ui.list({
                    key: 'list', label: b.title, empty: b.empty,
                    rows: b.rows.map((r) => h('div', { key: r.key, style: { ...styles.row, opacity: r.on ? 1 : 0.6 }, 'data-chord': r.chord }, h('span', { style: { flex: 'none', minWidth: 96 } }, ui.keys(r.caps)), h('div', { style: { flex: '1 1 160px', minWidth: 0 } }, ui.switch({ key: 'switch', label: r.label, checked: r.on, disabled: !r.toggle.enabled,
                        onChange: (next) => { if (next !== r.on)
                            send(r.toggle.change); } })), r.off === null ? null : ui.tag(r.off, 'warning'))),
                })],
        });
        const c = view.custom;
        const f = view.form;
        const formBox = f === null ? null : h('div', { key: 'form', style: FORM_STYLE, 'data-cu-runtime-form': 'chord' }, h('p', { style: styles.heading }, f.title), h('div', { style: styles.row }, ui.input({ key: 'chord', label: f.comboLabel, value: f.chord, placeholder: 'cmd+shift+k', maxLength: change_ts_1.CHANGE_LIMITS.chord,
            disabled: props.pending, onChange: (text) => edit({ chord: text }) }), f.caps.length === 0 ? null : ui.keys(f.caps)), h('p', { style: styles.note }, f.comboHint), ui.segmented({ key: 'scope', id: 'cu-runtime-chord-scope', label: f.scopeLabel, value: f.scope, options: f.scopes,
            disabled: props.pending, onChange: (next) => edit({ scope: next === 'one' ? 'one' : 'all' }) }), f.app === null ? null : h('div', { style: styles.row }, ui.input({ key: 'app', label: f.app.label, value: f.app.value, placeholder: 'com.example.app', maxLength: change_ts_1.CHANGE_LIMITS.bundleId,
            disabled: props.pending, onChange: (text) => edit({ app: text }) }), ui.button({ key: 'choose', label: f.app.chooseApp.label, disabled: !f.app.chooseApp.enabled,
            onClick: () => {
                const since = props.now / 1000;
                void props.action('choose_app').then((ok) => { if (ok)
                    setPick(since); });
            } })), f.waiting === null ? null : h('div', { style: styles.row, role: 'status' }, h('p', { style: styles.quiet }, f.waiting), ui.button({ key: 'stop', label: f.stopWaiting, onClick: () => setPick(null), variant: 'ghost' })), ui.input({ key: 'note', label: f.noteLabel, value: f.note, placeholder: f.notePlaceholder, maxLength: change_ts_1.CHANGE_LIMITS.note,
            disabled: props.pending, onChange: (text) => edit({ note: text }) }), h('div', { style: styles.actions }, ui.button({ key: 'cancel', label: f.cancel, onClick: () => { setForm(null); setPick(null); } }), ui.button({ key: 'submit', label: f.submit.label, disabled: !f.submit.enabled, variant: 'primary',
            onClick: () => send(f.submit.change, () => { setForm(null); setPick(null); }) })));
        const custom = ui.card({
            key: 'custom', title: c.title, note: c.note,
            trailing: ui.button({ key: 'add', label: c.add.label, disabled: !c.add.enabled, onClick: () => setForm(exports.EMPTY_CHORD_FORM) }),
            children: [
                formBox,
                ui.list({
                    key: 'list', label: c.title, empty: c.empty,
                    rows: c.rows.map((r) => h('div', { key: r.key, style: styles.row, 'data-custom-chord': r.chord }, h('span', { style: { flex: 'none', minWidth: 96 } }, ui.keys(r.caps)), h('span', { style: { flex: '1 1 160px', minWidth: 0, ...(r.hasNote ? {} : styles.quiet) } }, r.note), h('span', { style: { display: 'grid', fontSize: 12 } }, h('span', { style: styles.quiet }, r.scope), r.app === null || r.app.name === null ? null : h('code', { style: styles.code }, r.app.bundle_id)), ui.button({ key: 'remove', label: r.remove.label, disabled: !r.remove.enabled, onClick: () => send(r.remove.change) }))),
                }),
            ],
        });
        const n = view.never;
        const never = ui.card({
            key: 'never', title: n.title, note: n.note,
            children: [
                ui.list({
                    key: 'list', label: n.title, empty: n.empty,
                    rows: n.rows.map((r) => h('div', { key: r.key, style: { ...styles.row, opacity: 0.7 }, 'data-never': r.chord }, h('span', { style: { flex: 'none', minWidth: 96, textDecoration: 'line-through' } }, ui.keys(r.caps)), r.label === null ? h('code', { style: styles.code }, r.chord) : h('span', null, r.label))),
                }),
                h('div', { key: 'rules', style: { ...styles.actions, gap: 6 } }, ...n.rules.map((text) => h('span', { key: text }, ui.tag(text, 'quiet')))),
            ],
        });
        return h('div', { style: styles.tab, 'data-cu-runtime-tab': 'shortcuts' }, header, builtin, custom, never);
    },
};
			},
			"settings/ui.js": function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.tabPanelId = exports.STYLES = exports.BUTTON_BORDER = exports.LIST_MAX_HEIGHT = exports.present = void 0;
exports.button = button;
exports.dot = dot;
exports.tag = tag;
exports.tabBar = tabBar;
exports.makeKit = makeKit;
const react_1 = require("react");
const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
const present = (component) => typeof component === 'function' || (typeof component === 'object' && component !== null);
exports.present = present;
exports.LIST_MAX_HEIGHT = 240;
exports.BUTTON_BORDER = '1px solid var(--dsw-alias-border-l2)';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';
exports.STYLES = {
    tab: { display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 },
    line: { display: 'flex', alignItems: 'center', gap: 8, margin: 0, minWidth: 0 },
    row: { display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flexWrap: 'wrap' },
    heading: { margin: 0, fontSize: 13, fontWeight: 600 },
    note: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
    quiet: { margin: 0, color: 'var(--dsw-alias-label-secondary)' },
    warn: { margin: 0, color: 'var(--dsw-alias-state-warn-primary)' },
    error: { margin: 0, color: 'var(--dsw-alias-state-error-primary)', overflowWrap: 'anywhere' },
    code: { fontFamily: MONO, fontSize: 12, overflowWrap: 'anywhere' },
    actions: { display: 'flex', flexWrap: 'wrap', gap: 8 },
    card: { display: 'grid', gap: 10, padding: 14, border: '.5px solid var(--dsw-alias-border-l1)', borderRadius: 10, minWidth: 0 },
    cardHead: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, minWidth: 0 },
    list: { display: 'grid', overflow: 'auto', minWidth: 0 },
    listRow: { padding: '6px 0', borderTop: '.5px solid var(--dsw-alias-border-l1)', minWidth: 0 },
    button: {
        padding: '4px 12px', borderRadius: 8, border: exports.BUTTON_BORDER,
        background: 'none', color: 'inherit', font: 'inherit',
    },
    dialog: { display: 'grid', gap: 10, padding: 14, border: '.5px solid var(--dsw-alias-border-l4)', borderRadius: 10 },
    kbd: { fontFamily: MONO, fontSize: 11, padding: '0 4px', border: '.5px solid var(--dsw-alias-border-l4)', borderRadius: 4 },
    app: { display: 'grid', minWidth: 0 },
    appName: { fontWeight: 600, overflowWrap: 'anywhere' },
};
const DOT_COLOR = {
    done: 'var(--dsw-alias-state-success-primary)',
    warning: 'var(--dsw-alias-state-warn-primary)',
    ongoing: 'var(--dsw-alias-state-business-primary)',
    error: 'var(--dsw-alias-state-error-primary)',
    idle: 'var(--dsw-alias-state-idle-primary)',
};
function button({ key, label, onClick, disabled = false, variant = 'outline' }) {
    const { Button } = primitives;
    const props = { key: key ?? label, disabled, onClick };
    return (0, exports.present)(Button)
        ? (0, react_1.createElement)(Button, { ...props, variant, size: 'sm', ...(variant === 'primary' ? {} : { style: { border: exports.BUTTON_BORDER } }) }, label)
        : (0, react_1.createElement)('button', { ...props, type: 'button', style: { ...exports.STYLES.button, opacity: disabled ? 0.5 : 1 } }, label);
}
function dot(state) {
    const { StateDot } = primitives;
    if ((0, exports.present)(StateDot))
        return (0, react_1.createElement)(StateDot, { state });
    return (0, react_1.createElement)('span', { 'aria-hidden': true, 'data-state': state,
        style: { flex: 'none', width: 8, height: 8, borderRadius: '50%', background: DOT_COLOR[state] } });
}
function tag(text, tone = 'neutral') {
    const { Tag } = primitives;
    return (0, exports.present)(Tag) ? (0, react_1.createElement)(Tag, { tone }, text) : (0, react_1.createElement)('span', { 'data-tone': tone }, text);
}
function tabBar(spec) {
    const { SegmentedTabs } = primitives;
    const items = spec.items.map((i) => ({ ...i, id: `cu-runtime-tab-${i.value}`, panelId: (0, exports.tabPanelId)(i.value) }));
    if ((0, exports.present)(SegmentedTabs))
        return (0, react_1.createElement)(SegmentedTabs, { items, value: spec.value, onChange: spec.onChange, label: spec.label });
    return (0, react_1.createElement)('div', { role: 'tablist', 'aria-label': spec.label, style: { ...exports.STYLES.actions, gap: 4 } }, ...items.map((i) => {
        const selected = i.value === spec.value;
        return (0, react_1.createElement)('button', {
            key: i.value, type: 'button', role: 'tab', id: i.id, 'aria-selected': selected, 'aria-controls': i.panelId,
            tabIndex: selected ? 0 : -1, onClick: () => spec.onChange(i.value),
            style: { ...exports.STYLES.button, fontWeight: selected ? 600 : 400, background: selected ? 'var(--dsw-alias-bg-module-platform)' : 'none' },
        }, i.label);
    }));
}
const tabPanelId = (value) => `cu-runtime-panel-${value}`;
exports.tabPanelId = tabPanelId;
function makeKit(t) {
    return {
        h: react_1.createElement, useState: react_1.useState, useEffect: react_1.useEffect, styles: exports.STYLES, button, tag, dot,
        appLabel(app) {
            return (0, react_1.createElement)('span', { style: exports.STYLES.app, 'data-cu-runtime-app': app.bundle_id }, (0, react_1.createElement)('span', { style: exports.STYLES.appName }, app.name ?? app.bundle_id), (0, react_1.createElement)('code', { style: { ...exports.STYLES.code, color: 'var(--dsw-alias-label-secondary)' } }, app.bundle_id));
        },
        list({ key, label, rows, empty, maxHeight = exports.LIST_MAX_HEIGHT }) {
            if (rows.length === 0)
                return (0, react_1.createElement)('p', { key, style: exports.STYLES.quiet }, empty);
            return (0, react_1.createElement)('div', { key, role: 'list', 'aria-label': label, 'data-cu-runtime-list': '', style: { ...exports.STYLES.list, maxHeight } }, ...rows.map((row, i) => (0, react_1.createElement)('div', { key: String(i), role: 'listitem', style: exports.STYLES.listRow }, row)));
        },
        confirm({ open, title, text, confirmLabel, onConfirm, onCancel }) {
            if (!open)
                return null;
            const footer = (0, react_1.createElement)('div', { style: exports.STYLES.actions }, button({ key: 'cancel', label: t('settings.cancel'), onClick: onCancel }), button({ key: 'confirm', label: confirmLabel, onClick: onConfirm, variant: 'primary' }));
            const { Modal } = primitives;
            if ((0, exports.present)(Modal))
                return (0, react_1.createElement)(Modal, { open, onClose: onCancel, title, closeLabel: t('settings.close'), description: text, footer });
            return (0, react_1.createElement)('div', { role: 'dialog', 'aria-modal': true, 'aria-label': title, style: exports.STYLES.dialog }, (0, react_1.createElement)('p', { style: exports.STYLES.heading }, title), (0, react_1.createElement)('p', { style: exports.STYLES.quiet }, text), footer);
        },
        card({ key, title, note, trailing, children }) {
            return (0, react_1.createElement)('section', { key, style: exports.STYLES.card }, (0, react_1.createElement)('div', { style: exports.STYLES.cardHead }, (0, react_1.createElement)('div', { style: { display: 'grid', gap: 2, minWidth: 0 } }, (0, react_1.createElement)('h4', { style: exports.STYLES.heading }, title), note === undefined ? null : (0, react_1.createElement)('p', { style: exports.STYLES.note }, note)), trailing ?? null), ...children);
        },
        switch({ key, checked, onChange, label, disabled = false }) {
            const { Switch } = primitives;
            if ((0, exports.present)(Switch))
                return (0, react_1.createElement)(Switch, { key, checked, onChange, label, disabled });
            return (0, react_1.createElement)('label', { key, style: exports.STYLES.line }, (0, react_1.createElement)('input', { type: 'checkbox', role: 'switch', checked, disabled, 'aria-checked': checked,
                onChange: (e) => onChange(e.target.checked) }), (0, react_1.createElement)('span', null, label));
        },
        segmented({ key, id, value, options, onChange, label, disabled = false }) {
            const { SegmentedControl } = primitives;
            if ((0, exports.present)(SegmentedControl))
                return (0, react_1.createElement)(SegmentedControl, { key, id, value, options, onChange, label, disabled });
            return (0, react_1.createElement)('div', { key, id, role: 'radiogroup', 'aria-label': label, style: { ...exports.STYLES.actions, gap: 4 } }, ...options.map((o) => (0, react_1.createElement)('button', {
                key: o.value, type: 'button', role: 'radio', 'aria-checked': o.value === value,
                disabled: disabled || o.disabled === true, onClick: () => onChange(o.value),
                style: { ...exports.STYLES.button, fontWeight: o.value === value ? 600 : 400, opacity: disabled || o.disabled === true ? 0.5 : 1 },
            }, o.label)));
        },
        input({ key, value, onChange, label, placeholder, disabled = false, maxLength }) {
            const { Input } = primitives;
            const props = { key, value, disabled, 'aria-label': label, onChange: (e) => onChange(e.target.value),
                ...(placeholder === undefined ? {} : { placeholder }), ...(maxLength === undefined ? {} : { maxLength }) };
            return (0, exports.present)(Input) ? (0, react_1.createElement)(Input, props) : (0, react_1.createElement)('input', { ...props, type: 'text', style: { ...exports.STYLES.button, minWidth: 0 } });
        },
        disclosure({ key, title, open, onToggle, children }) {
            const { DisclosureRow } = primitives;
            if ((0, exports.present)(DisclosureRow))
                return (0, react_1.createElement)(DisclosureRow, { key, icon: null, title, open, expandable: true, onToggle }, ...children);
            return (0, react_1.createElement)('div', { key, style: { display: 'grid', gap: 8 } }, (0, react_1.createElement)('button', { type: 'button', 'aria-expanded': open, onClick: onToggle, style: { ...exports.STYLES.button, justifySelf: 'start' } }, `${open ? '▾' : '▸'} ${title}`), ...(open ? children : []));
        },
        keys(keys) {
            const { ShortcutKeys } = primitives;
            if ((0, exports.present)(ShortcutKeys))
                return (0, react_1.createElement)(ShortcutKeys, { keys });
            return (0, react_1.createElement)('span', { style: { ...exports.STYLES.line, gap: 2 } }, ...keys.map((k, i) => (0, react_1.createElement)('kbd', { key: String(i), style: exports.STYLES.kbd }, k)));
        },
        toast({ text, onDone }) {
            const { Toast } = primitives;
            return (0, exports.present)(Toast) ? (0, react_1.createElement)(Toast, { text, onDone }) : (0, react_1.createElement)('p', { role: 'status', style: exports.STYLES.quiet }, text);
        },
    };
}
			},
			"view.js": function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ERROR_CODES = exports.PAGE_ERROR_CODES = exports.HOST_ERROR_CODES = exports.LOG_LINES = exports.FINGERPRINT_COMMAND = exports.P12_FINGERPRINT_COMMAND = exports.TERMINAL_PHASES = exports.PHASES = void 0;
exports.opensslSha1 = opensslSha1;
exports.readStatus = readStatus;
exports.taskActive = taskActive;
exports.heldElsewhere = heldElsewhere;
exports.taskCancellable = taskCancellable;
exports.errorMessage = errorMessage;
exports.buildView = buildView;
exports.readModeCheck = readModeCheck;
exports.buildModeCheckView = buildModeCheckView;
exports.PHASES = ['preflight', 'identity', 'copy', 'build', 'sign', 'verify', 'stop', 'replace', 'start', 'selfcheck'];
exports.TERMINAL_PHASES = ['done', 'failed', 'cancelled'];
const LAST_CANCELLABLE = 'stop';
const LAST_KEYCHAIN = 'sign';
const DIALOG_PHASE = 'sign';
const SHA1 = /^[0-9A-Fa-f]{40}$/;
const SHA1_IN_TEXT = /(?<![0-9A-Fa-f"])[0-9A-Fa-f]{40}(?![0-9A-Fa-f"])/g;
exports.P12_FINGERPRINT_COMMAND = '/usr/bin/openssl pkcs12 -in <backup.p12> -nokeys -clcerts | /usr/bin/openssl x509 -noout -fingerprint -sha1';
exports.FINGERPRINT_COMMAND = 'openssl x509 -noout -fingerprint -sha1 -in ~/.cu-runtime-signing/cert.pem';
function opensslSha1(sha1) {
    return sha1.toUpperCase().match(/../g).join(':');
}
exports.LOG_LINES = 12;
exports.HOST_ERROR_CODES = ['busy', 'ssh_session', 'no_gui_session', 'clt_missing', 'identity_failed',
    'identity_ambiguous', 'identity_missing', 'identity_changed', 'copy_failed', 'build_failed', 'not_release_build',
    'sign_failed', 'signature_mismatch', 'stop_failed', 'replace_failed', 'start_failed', 'selfcheck_failed',
    'selfcheck_timeout', 'not_installed', 'clt_install_failed', 'no_task', 'not_cancellable', 'internal'];
exports.PAGE_ERROR_CODES = ['unauthorized', 'network', 'bad_response'];
exports.ERROR_CODES = [...exports.HOST_ERROR_CODES, ...exports.PAGE_ERROR_CODES];
const NOTICES = new Set(['permissions', 'clt']);
const isObject = (v) => typeof v === 'object' && v !== null;
const isBool = (v) => typeof v === 'boolean';
function readFailure(v) {
    if (v === null)
        return null;
    if (!isObject(v) || typeof v.code !== 'string')
        return undefined;
    return { code: v.code, message: typeof v.message === 'string' ? v.message : '' };
}
function readTask(v) {
    if (v === null)
        return null;
    if (!isObject(v) || typeof v.phase !== 'string')
        return undefined;
    const error = readFailure(v.error ?? null);
    if (error === undefined)
        return undefined;
    return {
        id: String(v.id ?? ''),
        phase: v.phase,
        startedAt: v.startedAt,
        log: Array.isArray(v.log) ? v.log.map(String) : [],
        error,
        endedIn: typeof v.endedIn === 'string' ? v.endedIn : null,
    };
}
function readBusy(v) {
    if (v === null)
        return null;
    if (!isObject(v) || typeof v.pid !== 'number' || !Number.isSafeInteger(v.pid) || v.pid <= 0 || typeof v.since !== 'string'
        || !isBool(v.self))
        return undefined;
    return { pid: v.pid, since: v.since, self: v.self };
}
const sha1Or = (v) => (typeof v === 'string' && SHA1.test(v) ? v : null);
function readStatus(raw) {
    const bad = () => {
        throw Object.assign(new Error('the status response does not have the expected fields'), { code: 'bad_response' });
    };
    if (!isObject(raw) || !isObject(raw.app) || !isObject(raw.environment))
        return bad();
    const { app, environment: env } = raw;
    const perms = raw.permissions;
    const pkg = isObject(raw.package) ? raw.package : {};
    const signature = app.signature;
    const task = readTask(raw.task ?? null);
    const busy = readBusy(raw.busy ?? null);
    const changed = app.identityChanged ?? false;
    if (!isBool(app.installed) || !isBool(raw.upToDate) || !isBool(raw.running))
        return bad();
    if (signature !== 'ok' && signature !== 'mismatch' && signature !== 'unsigned' && signature !== 'missing')
        return bad();
    if (!isBool(env.gui) || !isBool(env.clt) || !isBool(env.sshSession))
        return bad();
    if (perms !== null && !(isObject(perms) && isBool(perms.accessibility) && isBool(perms.screenRecording)))
        return bad();
    if (task === undefined || busy === undefined || !isBool(changed))
        return bad();
    return {
        app: {
            installed: app.installed,
            version: typeof app.version === 'string' ? app.version : null,
            sourceHash: typeof app.sourceHash === 'string' ? app.sourceHash : null,
            signature,
            identity: app.identity === 'present' || app.identity === 'ambiguous' ? app.identity : 'missing',
            identitySha1: sha1Or(app.identitySha1),
            identityKnown: sha1Or(app.identityKnown),
            identityKnownSource: app.identityKnownSource === 'record' || app.identityKnownSource === 'installedApp'
                ? app.identityKnownSource : null,
            identityChanged: changed,
        },
        package: {
            version: typeof pkg.version === 'string' ? pkg.version : '',
            sourceHash: typeof pkg.sourceHash === 'string' ? pkg.sourceHash : '',
        },
        upToDate: raw.upToDate,
        running: raw.running,
        permissions: perms === null ? null : { accessibility: perms.accessibility, screenRecording: perms.screenRecording },
        environment: { gui: env.gui, clt: env.clt, sshSession: env.sshSession },
        task,
        busy,
    };
}
function taskActive(task) {
    return task != null && !exports.TERMINAL_PHASES.includes(task.phase);
}
function heldElsewhere(status) {
    return !taskActive(status.task) && status.busy !== null;
}
function taskCancellable(task) {
    if (!taskActive(task))
        return false;
    const at = exports.PHASES.indexOf(task.phase);
    return at >= 0 && at <= exports.PHASES.indexOf(LAST_CANCELLABLE);
}
function phaseLabel(t, phase) {
    return exports.PHASES.includes(phase) ? t(`phase.${phase}`) : phase;
}
function errorMessage(t, failure, op = null) {
    if (failure == null)
        return null;
    const phase = /^(\w+)_failed$/.exec(failure.code)?.[1];
    const text = op === 'acceptIdentity' && failure.code === 'identity_changed' ? t('identity.changedAgain')
        : exports.ERROR_CODES.includes(failure.code) ? t(`error.${failure.code}`)
            : phase !== undefined && exports.PHASES.includes(phase) ? t('error.phaseFailed', { phase: phaseLabel(t, phase) })
                : t('error.unknown', { code: failure.code });
    const message = failure.message.trim().replace(SHA1_IN_TEXT, opensslSha1);
    const detail = message === '' ? null : t('error.detail', { message });
    return { text, detail };
}
function taskView(t, task) {
    const active = taskActive(task);
    const at = exports.PHASES.indexOf(task.phase);
    const log = task.log.slice(-exports.LOG_LINES).map((line) => line.replace(SHA1_IN_TEXT, opensslSha1));
    const ended = task.phase === 'failed' || task.phase === 'cancelled';
    return {
        title: t(active ? 'task.running' : `task.${task.phase}`),
        state: active ? 'ongoing' : task.phase === 'done' ? 'done' : task.phase === 'failed' ? 'error' : 'idle',
        step: active && at >= 0
            ? t('task.step', { index: at + 1, total: exports.PHASES.length, phase: phaseLabel(t, task.phase) })
            : null,
        keychain: active && at >= 0 && at <= exports.PHASES.indexOf(LAST_KEYCHAIN) ? t('task.keychain') : null,
        openDialog: ended && (task.endedIn === DIALOG_PHASE || task.error?.code === 'sign_failed') ? t('task.openDialog') : null,
        note: active && at > exports.PHASES.indexOf(LAST_CANCELLABLE) ? t('task.noCancel') : null,
        error: task.phase === 'failed' ? errorMessage(t, task.error ?? { code: 'unknown', message: '' }) : null,
        logTitle: t('task.log', { count: log.length }),
        log,
    };
}
function buildView(status, options) {
    const { t } = options;
    const pending = options.pending ?? null;
    const error = options.actionError != null ? errorMessage(t, options.actionError, options.actionErrorOp ?? null)
        : errorMessage(t, options.statusError);
    const notice = options.done != null && NOTICES.has(options.done) ? t(`notice.${options.done}`) : null;
    if (status === null) {
        return {
            summary: options.statusError != null
                ? { state: 'error', text: t('summary.unreadable') }
                : { state: 'idle', text: t('summary.loading') },
            sections: [], actions: [], identityChange: null, task: null, permissionsHint: null,
            pluginUpdateHint: t('hint.pluginUpdate'), notice, error,
        };
    }
    const { app, environment: env, permissions: perms, task } = status;
    const none = t('value.none');
    const active = taskActive(task);
    const held = heldElsewhere(status) ? status.busy : null;
    const busy = pending !== null || active || held !== null;
    const desktop = env.gui && !env.sshSession;
    const ambiguous = app.identity === 'ambiguous';
    const changed = app.identity === 'present' && app.identityChanged;
    const signed = app.installed && app.signature === 'ok' && !ambiguous;
    const trusted = signed && !changed;
    const granted = perms !== null && perms.accessibility && perms.screenRecording;
    const sha1 = (value) => (value === null ? none : opensslSha1(value));
    const known = app.identityKnownSource === 'installedApp' ? 'InstalledApp' : '';
    const permission = (id) => ({
        id,
        label: t(`row.${id}`),
        value: !app.installed ? none : perms === null ? t('value.unchecked') : perms[id] ? t('value.granted') : t('value.notGranted'),
        state: !app.installed ? null : perms === null ? 'idle' : perms[id] ? 'done' : 'warning',
    });
    const daemon = {
        id: 'daemon',
        title: t('section.daemon'),
        rows: [
            { id: 'installed', label: t('row.installed'), value: t(app.installed ? 'value.installed' : 'value.notInstalled'),
                state: app.installed ? 'done' : 'idle' },
            { id: 'version', label: t('row.version'), value: app.installed && app.version !== null ? app.version : none, state: null },
            { id: 'pluginVersion', label: t('row.pluginVersion'), value: status.package.version || none, state: null },
            { id: 'upToDate', label: t('row.upToDate'), value: !app.installed ? none : t(status.upToDate ? 'value.upToDate' : 'value.outdated'),
                state: !app.installed ? null : status.upToDate ? 'done' : 'warning' },
            { id: 'signature', label: t('row.signature'),
                value: !app.installed ? none : t(ambiguous ? 'value.signature.ambiguous' : `value.signature.${app.signature}`),
                state: !app.installed ? null : signed ? 'done' : 'error' },
            { id: 'identity', label: t('row.identity'),
                value: t(ambiguous ? 'value.identityAmbiguous' : changed ? `value.identityChanged${known}`
                    : app.identity === 'present' ? 'value.identityPresent' : 'value.identityMissing'),
                state: ambiguous || changed ? 'error' : app.identity === 'present' ? 'done' : 'idle' },
            { id: 'identitySha1', label: t('row.identitySha1'),
                value: app.identity === 'present' ? sha1(app.identitySha1) : none, state: null },
            ...(changed ? [{ id: 'identityKnown', label: t(`row.identityKnown${known}`), value: sha1(app.identityKnown), state: null }]
                : []),
            { id: 'running', label: t('row.running'), value: !app.installed ? none : t(status.running ? 'value.running' : 'value.stopped'),
                state: !app.installed ? null : status.running ? 'done' : 'idle' },
            permission('accessibility'),
            permission('screenRecording'),
        ],
    };
    const environment = {
        id: 'environment',
        title: t('section.environment'),
        rows: [
            { id: 'clt', label: t('row.clt'), value: t(env.clt ? 'value.cltInstalled' : 'value.cltMissing'), state: env.clt ? 'done' : 'warning' },
            { id: 'session', label: t('row.session'),
                value: t(env.sshSession ? 'value.sshSession' : env.gui ? 'value.guiSession' : 'value.noGui'),
                state: desktop ? 'done' : 'error' },
        ],
    };
    const enabled = {
        clt: !busy && desktop,
        install: !busy && desktop && env.clt && !ambiguous && !changed,
        permissions: !busy && desktop && trusted,
        selfcheck: !busy && desktop && trusted,
        start: !busy && desktop && trusted && !status.running,
        stop: !busy && status.running,
        restart: !busy && desktop && trusted && status.running,
        cancel: pending === null && taskCancellable(task),
        acceptIdentity: !busy && changed,
    };
    const next = !env.clt ? 'clt'
        : ambiguous || changed ? null
            : !app.installed || app.signature !== 'ok' || !status.upToDate ? 'install'
                : perms !== null && !granted ? (options.done === 'permissions' ? 'selfcheck' : 'permissions')
                    : !status.running ? 'start'
                        : perms === null ? 'selfcheck'
                            : null;
    const installLabel = !app.installed ? 'action.install' : app.signature !== 'ok' || status.upToDate ? 'action.reinstall' : 'action.update';
    const ops = [...(env.clt ? [] : ['clt']), ...(changed ? ['acceptIdentity'] : []),
        'install', 'permissions', 'selfcheck', 'start', 'stop', 'restart', ...(active ? ['cancel'] : [])];
    const actions = ops.map((op) => ({
        op,
        label: t(op === 'install' ? installLabel : `action.${op}`),
        enabled: enabled[op],
        variant: op === next && enabled[op] ? 'primary' : 'outline',
    }));
    const summary = active ? { state: 'ongoing', text: t('summary.task', { phase: phaseLabel(t, task.phase) }) }
        : held !== null ? { state: 'ongoing', text: t(held.self ? 'summary.busySelf' : 'summary.busyOther', { pid: held.pid, since: held.since }) }
            : !desktop ? { state: 'error', text: t(env.sshSession ? 'summary.sshSession' : 'summary.noGui') }
                : ambiguous ? { state: 'error', text: t('summary.identityAmbiguous') }
                    : changed ? { state: 'error', text: t(`summary.identityChanged${known}`) }
                        : !app.installed ? { state: 'idle', text: t('summary.notInstalled') }
                            : app.signature !== 'ok' ? { state: 'error', text: t('summary.signature') }
                                : !status.upToDate ? { state: 'warning', text: t('summary.outdated') }
                                    : perms !== null && !granted ? { state: 'warning', text: t('summary.permissions') }
                                        : !status.running ? { state: 'idle', text: t('summary.stopped') }
                                            : perms === null ? { state: 'idle', text: t('summary.unchecked') }
                                                : { state: 'done', text: t('summary.ready') };
    return {
        summary,
        sections: [daemon, environment],
        actions,
        identityChange: changed
            ? { text: t('identity.changed', { known: t(`identity.known${known}`) }),
                commands: [exports.P12_FINGERPRINT_COMMAND, exports.FINGERPRINT_COMMAND] }
            : null,
        task: task === null ? null : taskView(t, task),
        permissionsHint: !busy && desktop && trusted && !granted ? t('hint.permissions') : null,
        pluginUpdateHint: t('hint.pluginUpdate'),
        notice,
        error,
    };
}
const PROFILE_STATUSES = new Set(['ok', 'fail', 'skipped']);
function readModeCheck(raw) {
    const bad = () => {
        throw Object.assign(new Error('the mode check response does not have the expected fields'), { code: 'bad_response' });
    };
    const result = isObject(raw) ? raw.result : undefined;
    if (!isObject(result) || typeof result.checked_at !== 'string' || !isBool(result.ok) || !Array.isArray(result.profiles)) {
        return bad();
    }
    const profiles = result.profiles.map((p) => {
        if (!isObject(p) || typeof p.profile !== 'string' || !PROFILE_STATUSES.has(p.status) || !Array.isArray(p.lines)
            || !p.lines.every((l) => typeof l === 'string'))
            return bad();
        return { profile: p.profile, status: p.status, lines: p.lines };
    });
    return { checkedAt: result.checked_at, ok: result.ok, profiles };
}
function buildModeCheckView(result, options) {
    const { t } = options;
    const pending = options.pending ?? false;
    const failing = result?.profiles.filter((p) => p.status === 'fail') ?? [];
    const skipped = result?.profiles.filter((p) => p.status === 'skipped') ?? [];
    const listed = failing.length > 0 ? failing : skipped;
    const lines = listed.flatMap((p) => p.lines.map((l) => (p.profile === '' ? l : `${p.profile}: ${l}`)));
    const problems = failing.reduce((n, p) => n + Math.max(p.lines.length, 1), 0);
    const summary = result === null
        ? (pending ? { state: 'ongoing', text: t('modeCheck.checking') } : { state: 'idle', text: t('modeCheck.unchecked') })
        : problems > 0 ? { state: 'error', text: t('modeCheck.problems', { n: problems }) }
            : skipped.length > 0 || !result.ok || result.profiles.length === 0 ? { state: 'idle', text: t('modeCheck.unchecked') }
                : { state: 'done', text: t('modeCheck.ok') };
    return {
        title: t('section.modeCheck'),
        about: t('modeCheck.about'),
        ...summary,
        lines,
        checkedAt: result === null ? null : t('modeCheck.checkedAt', { at: result.checkedAt }),
        refresh: { label: t('action.modeCheckRefresh'), enabled: !pending },
        error: errorMessage(t, options.error),
    };
}
			},
		};
		var __links = {"api.js":{},"index.js":{"./locale.js":"locale.js","./settings/locale/index.js":"settings/locale/index.js","./settings/shell.js":"settings/shell.js"},"locale.js":{},"page.js":{"./api.js":"api.js","./settings/ui.js":"settings/ui.js","./view.js":"view.js"},"settings/api.js":{"./model.js":"settings/model.js"},"settings/change.js":{},"settings/locale/access.js":{},"settings/locale/apps.js":{},"settings/locale/behavior.js":{},"settings/locale/index.js":{"./access.js":"settings/locale/access.js","./apps.js":"settings/locale/apps.js","./behavior.js":"settings/locale/behavior.js","./logs.js":"settings/locale/logs.js","./overview.js":"settings/locale/overview.js","./privacy.js":"settings/locale/privacy.js","./shared.js":"settings/locale/shared.js","./shortcuts.js":"settings/locale/shortcuts.js"},"settings/locale/logs.js":{},"settings/locale/overview.js":{},"settings/locale/privacy.js":{},"settings/locale/shared.js":{},"settings/locale/shortcuts.js":{},"settings/model.js":{},"settings/shell.js":{"../page.js":"page.js","./api.js":"settings/api.js","./model.js":"settings/model.js","./tabs/index.js":"settings/tabs/index.js","./ui.js":"settings/ui.js"},"settings/tab.js":{},"settings/tabs/access.js":{},"settings/tabs/apps.js":{"../change.js":"settings/change.js"},"settings/tabs/behavior.js":{},"settings/tabs/index.js":{"./access.js":"settings/tabs/access.js","./apps.js":"settings/tabs/apps.js","./behavior.js":"settings/tabs/behavior.js","./logs.js":"settings/tabs/logs.js","./overview.js":"settings/tabs/overview.js","./privacy.js":"settings/tabs/privacy.js","./shortcuts.js":"settings/tabs/shortcuts.js"},"settings/tabs/logs.js":{"../model.js":"settings/model.js"},"settings/tabs/overview.js":{"../model.js":"settings/model.js"},"settings/tabs/privacy.js":{"../model.js":"settings/model.js"},"settings/tabs/shortcuts.js":{"../change.js":"settings/change.js","../model.js":"settings/model.js","./apps.js":"settings/tabs/apps.js"},"settings/ui.js":{},"view.js":{}};
		var __loaded = {};
		function __load(id, mod) {
			if (__loaded[id]) return __loaded[id].exports;
			__loaded[id] = mod;
			var links = __links[id];
			__modules[id].call(mod.exports, mod, mod.exports, function (spec) {
				return Object.prototype.hasOwnProperty.call(links, spec) ? __load(links[spec], { exports: {} }) : require(spec);
			});
			return mod.exports;
		}
		__load("index.js", module);
		return module.exports;
	}
});
