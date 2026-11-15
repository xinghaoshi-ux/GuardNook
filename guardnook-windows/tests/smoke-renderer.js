(async () => {
  await window.guardnookReady
  const checks = []
  const assert = (value, label) => { if (!value) throw new Error(label); checks.push(label) }
  const waitFor = async predicate => {
    const deadline = Date.now() + 5000
    while (!await predicate()) { if (Date.now() > deadline) throw new Error('Timed out waiting for renderer'); await new Promise(resolve => setTimeout(resolve, 50)) }
  }
  assert(typeof require === 'undefined' && typeof process === 'undefined', 'renderer has no Node.js access')
  assert(!document.querySelector('#setup').hidden, 'first launch opens node setup')
  document.querySelector('[data-tab=home]').click()
  document.querySelector('#todo-draft').value = 'Windows 移植验收'
  document.querySelector('#todo-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await waitFor(() => document.querySelector('#todo-list').textContent.includes('Windows 移植验收'))
  assert(true, 'todo form persists a task through IPC')
  document.querySelector('#todo-list input').click()
  await waitFor(() => document.querySelector('.todo-row.done'))
  assert(true, 'todo completion updates stored state')
  const note = document.querySelector('#note'); note.focus(); note.value = '本机笔记 · <script>literal text</script>'
  note.dispatchEvent(new Event('input', { bubbles: true }))
  await waitFor(async () => (await window.guardnook.boot()).value.board.note === note.value)
  assert(true, 'non-ASCII notes save literally without HTML execution')
  const invalid = await window.guardnook.board({ type: 'preferences', theme: '<script>' })
  assert(!invalid.ok, 'invalid preferences are rejected by main process')
  const launch = await window.guardnook.launch('cmd.exe /c injected')
  assert(!launch.ok, 'unknown launcher commands cannot execute')
  const controller = await window.guardnook.catalogue({ controllerURL: 'http://remote.invalid:9090' })
  assert(!controller.ok, 'remote controller input is rejected')
  const action = await window.guardnook.guard('enable')
  assert(!action.ok, 'unconfigured guard cannot be enabled')
  for (const tab of ['apps', 'guard', 'settings']) {
    document.querySelector(`[data-tab=${tab}]`).click()
    assert(!document.querySelector(`#${tab}`).hidden, `${tab} navigation opens`)
  }
  document.querySelector('#theme').value = 'light'; document.querySelector('#theme').dispatchEvent(new Event('change'))
  await waitFor(() => document.body.classList.contains('light'))
  assert(true, 'theme changes propagate from native app state')
  document.querySelector('#theme').value = 'dark'; document.querySelector('#theme').dispatchEvent(new Event('change'))
  await waitFor(() => !document.body.classList.contains('light'))
  await window.guardnook.window('collapse')
  await waitFor(() => !document.querySelector('#pill').hidden)
  assert(true, 'floating window collapses into its pill')
  await window.guardnook.window('expand')
  await waitFor(() => !document.querySelector('#panel').hidden)
  assert(true, 'floating window expands from its pill')
  document.querySelector('[data-tab=home]').click(); note.blur()
  return { passed: checks.length, checks, title: document.title, version: (await window.guardnook.boot()).value.version }
})()
