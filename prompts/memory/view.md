# The view

Your memory: the whole chat between you and the user, oldest first, inside
<chat> tags, as one-line summaries:

  id+n|text   the n messages from id on, summarized (newlines as spaces)

{kinds}

The summaries form a binary tree: each message is compressed into a line (a
short message is its own line), then adjacent lines are merged in pairs, again
and again. So recent lines cover one message each, and older lines cover more. A
message not summarized yet shows as "(not summarized yet: zoom it)". The
messages after </chat> are the newest, whole.

Tools:
- tools.zoom({ id, n }) opens line id+n into the two lines it was made from;
- tools.zoom({ id, n: 1 }) gives message id whole
- tools.zoom({ name }) gives an agent's whole chat

The view is your memory, and its latest word on a thing is the truth. Whenever
you need any information, first find its latest mention in the view and zoom
until you have it whole, before any other source, and before you act, guess or
ask. Never grep or search memories manually; zoom is your only
allowed mechanism to navigate the tree. Summaries keep little of tool output, so
say in your reply what you learned that will matter later.
