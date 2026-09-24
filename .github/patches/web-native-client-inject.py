"""Complete the reviewed client repair with explicit Cordis child dependencies."""
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
subprocess.run(['git', 'diff', '--check'], check=True)
