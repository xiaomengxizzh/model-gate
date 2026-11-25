#!/usr/bin/env python3
# mg-tray-linux.py — model-gateway 托盘管理器（Linux / KDE Plasma Wayland）
# 对标 Windows 版 mg-tray.cs 的托盘职责；网关本体由 systemd 用户服务守护：
#   systemctl --user: model-gateway.service（开机自启 + 崩溃自动拉活）
# 托盘职责：
#   - 两态图标（绿点=运行 / 灰点=停止）
#   - 菜单顶部实时显示：运行状态、今日请求/Token、每模型今日 in/out/花费、累计
#   - 右键控制：面板/启动/停止/重启/日志
# 数据源：/api/status（5s）+ /api/model-stats?days=1（30s，取今日 in/out）
# 花费：scripts/tray/mg-prices.json 自配单价 {"模型名": {"in": $/M, "out": $/M}}，缺省不显示
# 运行：/usr/bin/python3 scripts/tray/mg-tray-linux.py（依赖 gir1.2-ayatanaappindicator3-0.1）
import json
import os
import subprocess
import threading
import urllib.request

import gi
gi.require_version('AyatanaAppIndicator3', '0.1')
from gi.repository import AyatanaAppIndicator3, GLib

PROJ = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BASE = 'http://127.0.0.1:8787'
PANEL_URL = BASE + '/ui-vnext/'
UNIT = 'model-gateway.service'
ICON_DIR = os.path.join(PROJ, 'scripts', 'tray', 'icons')
PRICE_FILE = os.path.join(PROJ, 'scripts', 'tray', 'mg-prices.json')


def _get(path, timeout=2):
    with urllib.request.urlopen(BASE + path, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))


def fetch_status():
    try:
        return _get('/api/status')
    except Exception:
        return None


def fetch_today_io():
    """每模型今日 in/out token：{'模型名': (in, out)}"""
    try:
        d = _get('/api/model-stats?days=1')
        out = {}
        for name, arr in (d.get('models') or {}).items():
            if arr:
                last = arr[-1]
                out[name] = (last.get('inTokens') or 0, last.get('outTokens') or 0)
        return out
    except Exception:
        return {}


def load_prices():
    try:
        with open(PRICE_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}


def fmt_tok(n):
    if n >= 1e9:
        return '%.2fB' % (n / 1e9)
    if n >= 1e6:
        return '%.2fM' % (n / 1e6)
    if n >= 1e3:
        return '%.1fK' % (n / 1e3)
    return str(int(n))


def systemctl(action):
    subprocess.run(['systemctl', '--user', action, UNIT],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


class Tray:
    def __init__(self):
        self.ind = AyatanaAppIndicator3.Indicator.new(
            'model-gateway-tray', 'mg-tray-stopped',
            AyatanaAppIndicator3.IndicatorCategory.APPLICATION_STATUS)
        self.ind.set_status(AyatanaAppIndicator3.IndicatorStatus.ACTIVE)
        self.ind.set_icon_theme_path(ICON_DIR)
        self.ind.set_title('model-gateway')
        self.status = None      # /api/status 结果
        self.io = {}            # 模型 -> (in, out) 今日
        self.prices = load_prices()
        self.refresh()
        GLib.timeout_add_seconds(5, self.tick_fast)
        GLib.timeout_add_seconds(30, self.tick_slow)

    # ---------- 数据 ----------
    def tick_fast(self):
        self.status = fetch_status()
        self.refresh()
        return True

    def tick_slow(self):
        self.io = fetch_today_io()
        self.prices = load_prices()
        self.refresh()
        return True

    def refresh(self):
        running = self.status is not None
        self.ind.set_icon_full(
            'mg-tray-running' if running else 'mg-tray-stopped',
            '网关运行中' if running else '网关已停止')
        self.build_menu(running)

    # ---------- 展示 ----------
    def today_lines(self):
        """生成菜单顶部数据行（纯展示用）"""
        lines = []
        if self.status is None:
            lines.append(('● 网关未运行', None))
            return lines
        g = self.status.get('global') or {}
        models = self.status.get('models') or []
        today_total = g.get('todayTokens') or 0
        lines.append(('● 运行中 · 今日 %s tok · %s 请求' %
                      (fmt_tok(today_total), g.get('requests', 0)), None))
        # 每模型今日明细（按今日 token 降序，最多 8 行）
        rows = []
        for m in models:
            t = m.get('today') or 0
            if t <= 0:
                continue
            io = self.io.get(m['name']) or (0, 0)
            cost = self._cost(m['name'], io)
            rows.append((t, '  %s：%s（入 %s / 出 %s）%s' %
                         (m['name'], fmt_tok(t), fmt_tok(io[0]), fmt_tok(io[1]), cost)))
        rows.sort(reverse=True, key=lambda x: x[0])
        for _, text in rows[:8]:
            lines.append((text, None))
        if not rows:
            lines.append(('  今日暂无模型流量', None))
        lines.append(('累计 %s tok · %s 请求 · %s 错误' %
                      (fmt_tok(g.get('tokenCount') or 0),
                       g.get('requests', 0), g.get('errors', 0)), None))
        return lines

    def _cost(self, model, io):
        p = self.prices.get(model)
        if not p:
            return ''
        try:
            c = io[0] / 1e6 * float(p.get('in', 0)) + io[1] / 1e6 * float(p.get('out', 0))
            return ' · $%.4f' % c
        except Exception:
            return ''

    def build_menu(self, running):
        from gi.repository import Gtk
        menu = Gtk.Menu.new()
        for text, _ in self.today_lines():
            item = Gtk.MenuItem.new_with_label(text)
            item.set_sensitive(False)  # 纯展示，不可点
            menu.append(item)
        sep = Gtk.SeparatorMenuItem.new()
        menu.append(sep)
        actions = [('打开面板', lambda *_: subprocess.Popen(['xdg-open', PANEL_URL]))]
        if running:
            actions += [('重启网关', lambda *_: systemctl('restart')),
                        ('停止网关', lambda *_: systemctl('stop'))]
        else:
            actions += [('启动网关', lambda *_: systemctl('start'))]
        actions += [('打开日志目录', lambda *_: subprocess.Popen(['xdg-open', os.path.join(PROJ, 'logs')])),
                    ('退出托盘（网关继续运行）', lambda *_: Gtk.main_quit())]
        for label, fn in actions:
            item = Gtk.MenuItem.new_with_label(label)
            item.connect('activate', fn)
            menu.append(item)
        menu.show_all()
        self.ind.set_menu(menu)


def main():
    # 单实例：锁文件（含 pid 探活）
    lock = '/tmp/mg-tray-linux.lock'
    if os.path.exists(lock):
        try:
            old = int(open(lock).read().strip() or 0)
            os.kill(old, 0)  # 不抛异常 = 进程还活着
            return 0         # 已有实例在跑
        except (ValueError, ProcessLookupError):
            pass             # 死锁/残留 → 接管
    with open(lock, 'w') as f:
        f.write(str(os.getpid()))
    if not os.path.exists('/run/user/1000/bus'):
        print('无用户会话总线，退出', file=__import__('sys').stderr)
        return 1
    Tray()
    from gi.repository import Gtk
    Gtk.main()


if __name__ == '__main__':
    main()
