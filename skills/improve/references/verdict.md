# Verdict

Judge each `pending` row against today's `signals.json`.

- Rate is the signal's count divided by `owner_turns`. The row's `baseline` column is the before value.
- If today's `owner_turns` is under 10, leave the row `pending`.
- `helped`: the rate fell by 30% or more, or the count fell to 0 from 2 or more.
- `hurt`: the rate rose by 30% or more and the count rose by 2 or more, or a transcript shows the edit caused a new failure (cite the entry).
- `no observed effect`: neither. After 3 nights of `no observed effect`, revert the edit: it costs context and buys nothing.
- `confounded`: another edit on the same signal went live the same night. Leave both pending one more night, then judge them together.

Write the verdict, today's rate and one line of evidence into the row. A row is judged once it leaves `pending`.
