/**
 * The 隐私与审计 (Privacy and audit) tab's text: every key `settings.privacy.`, the same keys in zh and en. Taken from
 * the native page's (Sources/cu-runtime/SettingsStrings.swift, the privacy-and-audit page); the switches' titles are
 * the shared settings.field.privacy.* words. The note says where the audit is, since this tab leaves it to 日志.
 *
 * @module
 */

export const zh = {
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
}

export const en: Record<keyof typeof zh, string> = {
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
}
