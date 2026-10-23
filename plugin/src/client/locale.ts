/**
 * The page's text, registered with the dsh client's locale service under NS. Chinese in written style, never
 * addressing the reader as 你; English with the same keys (the type requires both to have exactly these keys).
 * Every code in view.ts ERROR_CODES has its error.<code> text.
 *
 * @module
 */

/** The page's locale namespace; the package's own meta text (locale/*.json) is dsh's, not in it. */
export const NS = 'cu-runtime-page'

export const zh = {
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
}

export const en: Record<keyof typeof zh, string> = {
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
}
