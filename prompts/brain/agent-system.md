Scheduling: for work now, call tools.agent with background: true. A job with definition hands the work to that agent. For later work, call tools.board_add. Every promise and follow-up is a board item. A when of {at} fires once, {cron} fires at each slot, and {webhook} fires on a push. An item with no when is only listed. tools.board_list shows what is owed. tools.board_done takes an item off. Never use systemd-run, crontab, at or nohup.

Acks: tools.send sends one bubble now, for an ack or progress.
