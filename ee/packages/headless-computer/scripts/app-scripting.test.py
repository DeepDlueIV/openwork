import importlib.util
import io
import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch
sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[1] / 'src/scripting'


def load(name, mocks):
    spec = importlib.util.spec_from_file_location(name, ROOT / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, mocks):
        spec.loader.exec_module(module)
    return module


class AppScriptingSafety(unittest.TestCase):
    def test_stop_during_render_prevents_the_following_save(self):
        bpy = types.ModuleType('bpy')
        saves = []
        bpy.data = types.SimpleNamespace(filepath='/workspace/out/scene.blend')
        bpy.ops = types.SimpleNamespace(wm=types.SimpleNamespace(save_mainfile=lambda: saves.append(True)))
        blender = load('openwork_blender', {'bpy': bpy})
        stopped = False

        def render(*args):
            nonlocal stopped
            stopped = True
            return {'path': '/workspace/out/render.png'}

        with patch.object(blender, '_view3d', return_value=None), patch.object(blender, 'summary', return_value={'unsaved': True}), patch.object(blender, '_render', render):
            result = blender.execute({'code': 'result = 1', 'render': 'final', 'output': '/workspace/out/render.png', 'save': True}, lambda: stopped)
        self.assertFalse(result['ok'])
        self.assertEqual(result['error'], 'cancelled')
        self.assertEqual(saves, [])

    def test_blender_bridge_uses_the_instance_pid(self):
        blender = load('openwork_blender', {'bpy': types.ModuleType('bpy')})
        with patch.object(blender.sys, 'argv', ['bridge.py', '--', 'serve', '/tmp/scripting']), patch.object(blender.os, 'getpid', return_value=1234), patch.object(blender, 'Bridge') as bridge:
            blender.main()
            bridge.assert_called_once_with('/tmp/scripting/blender-1234.sock')

    def office(self):
        uno = types.ModuleType('uno')
        uno.systemPathToFileUrl = lambda path: 'file://' + path
        uno.fileUrlToSystemPath = lambda path: path.removeprefix('file://')
        beans = types.ModuleType('com.sun.star.beans')
        beans.PropertyValue = type('PropertyValue', (), {})
        connection = types.ModuleType('com.sun.star.connection')
        connection.NoConnectException = type('NoConnectException', (Exception,), {})
        return load('openwork_office', {'uno': uno, 'com.sun.star.beans': beans, 'com.sun.star.connection': connection})

    def test_direct_file_is_saved_and_closed_without_closing_existing_windows(self):
        for already_open in [False, True]:
            with self.subTest(already_open=already_open):
                office = self.office()
                document = types.SimpleNamespace(URL='file:///workspace/out/budget.ods', supportsService=lambda service: True,
                                                 isModified=lambda: True)
                from unittest.mock import Mock
                document.store = Mock()
                document.close = Mock()
                desktop = types.SimpleNamespace(loadComponentFromURL=lambda *args: document, getCurrentComponent=lambda: document)
                data = json.dumps({'path': '/workspace/out/budget.ods', 'operation': 'write_range'})
                with patch.object(office, 'connect', return_value=desktop), patch.object(office, 'find_open', return_value=document if already_open else None), patch.object(office, 'operate', return_value={'changedCount': 1}), patch.object(office.sys, 'stdin', io.StringIO(data)):
                    result = office.main()
                self.assertEqual(document.store.call_count, 0 if already_open else 1)
                self.assertEqual(document.close.call_count, 0 if already_open else 1)
                self.assertEqual(result['target'], 'open window' if already_open else 'file')


if __name__ == '__main__':
    unittest.main()
