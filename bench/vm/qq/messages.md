# T7 message script

Sent **once**, from the maintainer's own QQ account (phone) to the test account logged in inside the VM base, while
the base is up for the set-up session. The expected answers of `T7-qq-*` are these strings, so they must be sent
exactly as written: one message per line, in this order, nothing else in between, no other message to the test
account afterwards (a clone syncs from the server when QQ starts; a later message would change every task's screen).

Copy each line as is (the emoji are the system ones, not QQ's own sticker faces):

1. `周五的评审改到下午 3 点半，地点 B-302 会议室。`
2. `订单号 QH-20261001-8K7Z，已经付款，帮忙查下物流。`
3. `取件码 Il1O0-5S8B，放在 3 号柜。`
4. `好的👍 收到🎉`
5. `晚上 7 点老地方见，记得带伞☔`

What each line is for:

| # | content | used by |
|---|---|---|
| 1 | filler, plain text with a room number | — (pushes the order line up; not one of the latest 3) |
| 2 | order number without look-alike characters | `T7-qq-order` (exact) |
| 3 | pickup code made of look-alikes: capital I, lower-case l, one, capital O, zero, then 5 S 8 B | `T7-qq-code` (exact), `T7-qq-latest` |
| 4 | two emoji in a short line (OCR outputs no emoji) | `T7-qq-latest` |
| 5 | latest message, ends in an emoji | `T7-qq-latest` |

After sending: in the test account, **pin** this conversation (置顶), then close it (no conversation selected), so
every job starts from the conversation list and has to click it open.
