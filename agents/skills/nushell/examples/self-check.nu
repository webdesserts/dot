# Run with: nu --no-config-file <path-to-this-file>
# Do not source into an active MCP session: this fixture owns its job mailbox.
# Uses synthetic data and short local subprocesses; no live service or file writes.
use std/assert

# Typed pipeline commands keep reusable operations discoverable.
def "demo totals" []: table<team: string, value: int> -> table<team: string, total: int> {
    group-by team
    | transpose team rows
    | select team rows
    | insert total {|row| $row.rows | get value | math sum }
    | reject rows
    | sort-by team
}

let rows = [[team value]; [a 2] [a 3] [b 4]]
let totals = ($rows | demo totals)
assert ($totals == [[team total]; [a 5] [b 4]])
assert (($totals | to json | from json) == $totals)
assert ((scope commands | where name == 'demo totals' | length) == 1)

let captured = (^sh -c 'printf payload; printf diagnostic >&2; exit 3' | complete)
assert ($captured.stdout == 'payload')
assert ($captured.stderr == 'diagnostic')
assert ($captured.exit_code == 3)
let caught = (try { ^sh -c 'exit 7'; 0 } catch {|e| $e.exit_code })
assert ($caught == 7)

let computed = (try { {ok: true, value: 42} } catch { null })
assert ($computed.value == 42)
mut variant: any = null
$variant = {value: 42}
assert ($variant.value == 42)

let existing = $env.IRIS_NU_TEST?
let scoped = (with-env {IRIS_NU_TEST: 'temporary'} { $env.IRIS_NU_TEST })
assert ($scoped == 'temporary')
assert ($env.IRIS_NU_TEST? == $existing)

assert (('demo/t:7' | url encode --all) == 'demo%2Ft%3A7')
assert (('demo/t:7' | url encode) == 'demo/t:7')
let parallel = (1..8 | par-each --threads 2 {|n| $n * $n} | sort)
assert ($parallel == [1 4 9 16 25 36 49 64])

let before_jobs = (job list | length)
let job_id = (job spawn --description 'bounded skill fixture' {
    {kind: 'other'} | job send 0 --tag 6061
    {kind: 'fixture', answer: 42} | job send 0 --tag 6077
})
let message = (job recv --tag 6077 --timeout 5sec)
assert ($message.answer == 42)
assert ((job recv --tag 6061 --timeout 5sec).kind == 'other')
let records = [{hash: 'abc'}]
assert (($records | last | get hash) == 'abc')
assert (($records | last 1 | get hash) == ['abc'])

let typed_failure = (^nu --no-config-file --commands 'def twice [n: int]: nothing -> int { $n * 2 }; twice wrong' | complete)
assert ($typed_failure.exit_code != 0)

{passed: true, groups: 9, version: (version).version, totals: $totals, job_id: $job_id, jobs_after: (job list | length), jobs_before: $before_jobs} | to json
