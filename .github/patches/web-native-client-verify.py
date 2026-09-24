"""Complete the reviewed repair and keep the real-browser proof independent of reviewer call ordering."""
from pathlib import Path
import subprocess

assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip() == '1bc2bf92d0b0ec80dfd969696fcad3acd23d8dee'

def replace(path, before, after):
    text = path.read_text()
    assert text.count(before) == 1, (str(path), before[:80], text.count(before))
    path.write_text(text.replace(before, after))

owner = Path('plugins/assistant-web-owner')
replace(owner / 'src/index.ts',
        '  scoped.inject(Controller.inject, async active => {',
        "  scoped.inject([...Controller.inject, 'loader'], async active => {")
replace(owner / 'src/index.ts',
        "      name: 'assistant-web-owner-native-controller',\n      apply(controllerCtx: Context) {",
        "      name: 'assistant-web-owner-native-controller',\n      inject: Controller.inject,\n      apply(controllerCtx: Context) {")
replace(owner / 'tests/native-client.spec.ts',
        '      const owner = ctx.plugin({ async apply(active: Context) {',
        "      const owner = ctx.plugin({ inject: ['loader'], async apply(active: Context) {")
replace(owner / 'tests/native-client.spec.ts',
        '        tree = createOwnerSessionTree(active, EntryTree, path, { apply(inner: Context) {\n          starts++',
        "        tree = createOwnerSessionTree(active, EntryTree, path, { inject: ['loader'], apply(inner: Context) {\n          expect(inner.loader).toBeDefined()\n          starts++")
spec = Path('scripts/e2e/web-owner.spec.mjs')
replace(spec,
        "    await expect(page.getByText('Browser owner reply 2', { exact: true })).toBeVisible()",
        "    // Independent permission review can consume a fixture model call.\n    // Bind the actual visible owner reply, not a global model-call ordinal.\n    const firstReply = page.getByText(/^Browser owner reply [1-6]$/).first()\n    await expect(firstReply).toBeVisible()\n    const initialReply = await firstReply.innerText()")
replace(spec,
        "    await expect(resumedPage.getByText('Browser owner reply 2', { exact: true })).toBeVisible()",
        "    await expect(resumedPage.getByText(initialReply, { exact: true })).toBeVisible()")
replace(spec,
        "    expect(calls.length).toBe(callsBeforePrompt + 1)",
        "    expect(calls.length).toBe(callsBeforePrompt + 1)\n    expect(calls.some(call => call.type === 'reply' && `Browser owner reply ${call.call}` === initialReply)).toBe(true)")
replace(spec,
        "      goalScope: scope, approvedTool: 'goal_create',",
        "      goalScope: scope, approvedTool: 'goal_create', initialReply,")
subprocess.run(['git', 'diff', '--check'], check=True)
