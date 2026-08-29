// mg-tray.cs — model-gateway 托盘 + 悬浮小窗管理器（零第三方依赖：Windows 自带 .NET Framework 编译运行）
// 编译：scripts\tray\build.cmd → 项目根 mg-tray.exe；双击运行，无控制台窗口。
// 职责：拉起/守护 node src/index.js（崩溃 5s 退避自动拉活，连续快速失败熔断）、
//       悬浮小窗显示状态与快捷操作、托盘常驻、开机自启（HKCU Run）、启动前清端口残留 node（同 start.bat 语义）。
// 外观：赛璐璐风，配色/语言与 admin.html 面板 dark 主题同源：
//       卡片 + 2px 描边 + 硬偏移阴影(3px3px0) + 胶囊按钮悬停抬升 + 菱形 gem + 健康徽章 + 等宽字体。
// 语法约束：in-box csc.exe 仅支持 C# 5——不得使用 $"" / ?. / out var / using var / nameof。
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;

namespace MgTray
{
    static class Program
    {
        [DllImport("user32.dll")]
        static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")]
        static extern IntPtr SetProcessDpiAwarenessContext(IntPtr value);

        [STAThread]
        static void Main()
        {
            bool created;
            var mutex = new Mutex(true, "model-gateway-tray-mutex", out created);
            if (!created)
            {
                // 已有实例：发信号让托盘弹出小窗，本进程退出
                EventWaitHandle existing;
                if (EventWaitHandle.TryOpenExisting("model-gateway-tray-show", out existing)) existing.Set();
                return;
            }
            // DPI 感知：PerMonitorV2 文字原生渲染不发虚；老系统回退 SetProcessDPIAware
            try { SetProcessDpiAwarenessContext(new IntPtr(-4)); }
            catch { try { SetProcessDPIAware(); } catch { } }
            using (var g = Graphics.FromHwnd(IntPtr.Zero)) Mg.Scale = g.DpiX / 96f;
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new TrayApp());
        }
    }

    // 面板 dark 主题真值（admin.html [data-theme="dark"]）
    static class Theme
    {
        public static readonly Color Sink = Color.FromArgb(0x10, 0x1A, 0x4E);      // 页面底
        public static readonly Color Card = Color.FromArgb(0x1B, 0x25, 0x66);      // 卡片
        public static readonly Color Card2 = Color.FromArgb(0x1D, 0x2A, 0x72);     // 行/按钮
        public static readonly Color Edge = Color.FromArgb(0x3D, 0x4D, 0xAB);      // 描边
        public static readonly Color Shadow = Color.FromArgb(0x0A, 0x12, 0x36);    // 硬偏移阴影
        public static readonly Color Ink = Color.FromArgb(0xEE, 0xF1, 0xFF);       // 主文本
        public static readonly Color Ink2 = Color.FromArgb(0xCF, 0xDC, 0xFF);      // 次文本
        public static readonly Color Ink3 = Color.FromArgb(0xA4, 0xB0, 0xF2);      // 弱化
        public static readonly Color Accent = Color.FromArgb(0x86, 0xA0, 0xFF);    // 主色
        public static readonly Color AccentH = Color.FromArgb(0x9C, 0xB0, 0xFF);     // 主色悬停
        public static readonly Color AccentD = Color.FromArgb(0x7A, 0x90, 0xF0);     // 主色按压
        public static readonly Color Card2H = Color.FromArgb(0x26, 0x32, 0x7E);     // 卡2悬停
        public static readonly Color TermBg = Color.FromArgb(0x0A, 0x0E, 0x24);    // 终端底（托盘图标底）
        public static readonly Color Ok = Color.FromArgb(0x37, 0xD6, 0x7A);
        public static readonly Color Warn = Color.FromArgb(0xFF, 0xB0, 0x20);
        public static readonly Color Err = Color.FromArgb(0xFF, 0x54, 0x70);
    }

    static class MgFonts
    {
        static bool Has(string name)
        {
            try { foreach (var f in FontFamily.Families) if (f.Name == name) return true; } catch { }
            return false;
        }
        static readonly string MonoName = Has("Cascadia Mono") ? "Cascadia Mono" : "Consolas";
        static readonly string MarkName = Has("Bahnschrift") ? "Bahnschrift" : "Arial Narrow";
        public static Font Mono(float size) { return new Font(MonoName, size * Mg.Scale); }
        public static Font Mark(float size) { return new Font(MarkName, size * Mg.Scale, FontStyle.Bold); }
    }

    static class Mg
    {
        // DPI 缩放系数（Main 里按主屏 DpiX 设定）；X() 把 96dpi 设计稿坐标换算到实际 DPI
        public static float Scale = 1f;
        public static int X(int v) { return (int)Math.Round(v * Scale); }

        [DllImport("dwmapi.dll")]
        public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

        public static GraphicsPath RoundRect(Rectangle r, int rad)
        {
            var p = new GraphicsPath();
            int d = rad * 2;
            if (d <= 0 || r.Width < d || r.Height < d) { p.AddRectangle(r); return p; }
            p.AddArc(r.X, r.Y, d, d, 180, 90);
            p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }
    }

    // 圆角按钮（电脑管家式）：底色分层 + 悬停提亮 + 按压压暗，无描边堆叠/无硬阴影
    // kind: 0=Primary(accent 填充) 1=Ghost(card2 填充+1px 边) 2=Mini(✕ 方角)
    internal class MgButton : Control
    {
        readonly int _kind;
        bool _hot, _down;

        public MgButton(string text, int x, int y, int w, int h, int kind)
        {
            Text = text;
            Bounds = new Rectangle(x, y, w, h);
            _kind = kind;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer
                | ControlStyles.UserPaint | ControlStyles.ResizeRedraw | ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent;
            Font = MgFonts.Mono(9.5f);
            Cursor = Cursors.Hand;
            MouseEnter += delegate { _hot = true; Invalidate(); };
            MouseLeave += delegate { _hot = false; _down = false; Invalidate(); };
            MouseDown += delegate(object s, MouseEventArgs e) { if (e.Button == MouseButtons.Left) { _down = true; Invalidate(); } };
            MouseUp += delegate { if (_down) { _down = false; Invalidate(); } };
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            var r = new Rectangle(0, 0, Width - 1, Height - 1);
            Color fill = _kind == 0
                ? (_down ? Theme.AccentD : (_hot ? Theme.AccentH : Theme.Accent))
                : (_kind == 1 ? (_hot ? Theme.Card2H : Theme.Card2) : (_hot ? Theme.Card2H : Theme.Card));
            using (var b = new SolidBrush(fill))
            using (var p = Mg.RoundRect(r, Mg.X(8)))
            {
                g.FillPath(b, p);
                if (_kind == 1)
                {
                    using (var pen = new Pen(Theme.Edge)) g.DrawPath(pen, p);
                }
            }
            Color txt = _kind == 0
                ? Color.White
                : (_kind == 2 ? (_hot ? Theme.Accent : Theme.Ink3) : (_hot ? Theme.Ink : Theme.Ink2));
            TextRenderer.DrawText(g, Text, Font, r, txt,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
        }
    }

    internal class StatusInfo
    {
        public bool Alive;        // healthz 200
        public bool StatsOk;      // /api/status 200
        public bool NeedAuth;     // /api/status 401（设置了管理令牌）
        public long UptimeMs;
        public long TodayTokens;
        public long Requests;
        public long Errors;
        public bool Owned;        // 由本托盘拉起且存活
        public string State;      // running / stopped / starting
        public string CurModel;   // 最近一次成功服务的模型（/api/status lastServing）
    }

    internal class TrayApp : ApplicationContext
    {
        const string RunKeyPath = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
        const string RunValueName = "model-gateway-tray";

        readonly string _root = AppDomain.CurrentDomain.BaseDirectory;
        readonly int _port;
        readonly MiniForm _mini;
        readonly NotifyIcon _tray;
        readonly System.Windows.Forms.Timer _poll;   // UI 线程轮询
        readonly EventWaitHandle _showEvent;
        Icon _iconRun, _iconStop, _iconFail;
        Process _proc;            // 本托盘拉起的网关
        bool _stopping;           // 人为停止中（看门狗不干预）
        int _fastFails;           // 连续快速失败计数（进程存活 <10s 记一次）
        DateTime _startedAt;

        public TrayApp()
        {
            _port = ReadPort();
            _mini = new MiniForm(this);
            var forceHandle = _mini.Handle; // 提前建句柄，后台线程 BeginInvoke 才可用

            _iconRun = MakeIcon(Theme.Ok);
            _iconStop = MakeIcon(Theme.Ink3);
            _iconFail = MakeIcon(Theme.Err);

            _tray = new NotifyIcon();
            _tray.Icon = _iconStop;
            _tray.Text = "model-gateway 托盘";
            _tray.Visible = true;
            _tray.DoubleClick += delegate { ShowMini(); };
            _tray.MouseClick += delegate(object s, MouseEventArgs e) { if (e.Button == MouseButtons.Left) ShowMini(); };
            _tray.ContextMenuStrip = BuildMenu();

            // 第二实例唤起小窗
            _showEvent = new EventWaitHandle(false, EventResetMode.AutoReset, "model-gateway-tray-show");
            ThreadPool.QueueUserWorkItem(delegate {
                while (_showEvent.WaitOne())
                {
                    for (int i = 0; i < 20; i++)
                    {
                        try { _mini.BeginInvoke((MethodInvoker)delegate { ShowMini(); }); break; }
                        catch (InvalidOperationException) { Thread.Sleep(300); }
                    }
                }
            });

            _poll = new System.Windows.Forms.Timer { Interval = 2000 };
            _poll.Tick += PollTick;
            _poll.Start();

            ShowMini();
            _tray.ShowBalloonTip(2500, "model-gateway", "托盘已启动；双击图标可唤出悬浮小窗。", ToolTipIcon.Info);
        }

        public int Port { get { return _port; } }
        public string Root { get { return _root; } }

        // ---------- 配置 ----------
        int ReadPort()
        {
            try
            {
                var cfg = File.ReadAllText(Path.Combine(_root, "config", "gateway.json"));
                var m = Regex.Match(cfg, "\"port\"\\s*:\\s*(\\d+)");
                if (m.Success)
                {
                    int p;
                    if (int.TryParse(m.Groups[1].Value, out p) && p > 0 && p < 65536) return p;
                }
            }
            catch { }
            return 8787;
        }

        // ---------- 状态轮询 ----------
        void PollTick(object sender, EventArgs e)
        {
            int port = _port;
            Task.Factory.StartNew(delegate
            {
                var st = PollOnce(port);
                try { _mini.BeginInvoke((MethodInvoker)delegate { ApplyStatus(st); }); } catch { }
            });
        }

        StatusInfo PollOnce(int port)
        {
            var st = new StatusInfo();
            st.Owned = _proc != null;
            try { st.Owned = st.Owned && _proc.HasExited == false; }
            catch { st.Owned = false; }
            string body;
            int code = HttpGet("http://127.0.0.1:" + port + "/healthz", 1500, out body);
            st.Alive = code == 200;
            if (!st.Alive)
            {
                st.State = (st.Owned && _fastFails < 5) ? "starting" : "stopped";
                return st;
            }
            st.State = "running";
            code = HttpGet("http://127.0.0.1:" + port + "/api/status", 1500, out body);
            if (code == 401) { st.NeedAuth = true; return st; }
            if (code == 200 && body != null)
            {
                st.StatsOk = true;
                st.UptimeMs = Num(Regex.Match(body, "\"uptimeMs\":(\\d+)"));
                st.TodayTokens = Num(Regex.Match(body, "\"todayTokens\":(\\d+)"));
                // 当前使用的模型：网关记录最近一次成功服务的 serving（index.js 数据面回写）
                var msrv = Regex.Match(body, "\"lastServing\":\\{\"model\":\"([^\"]*)\"");
                if (msrv.Success) st.CurModel = msrv.Groups[1].Value;
                // global 对象里 requests/errors 位于嵌套 latTrend 之前，截到第一个 } 前已含所需字段
                var g = Regex.Match(body, "\"global\":\\{([^}]*)\\}");
                if (g.Success)
                {
                    st.Requests = Num(Regex.Match(g.Groups[1].Value, "\"requests\":(\\d+)"));
                    st.Errors = Num(Regex.Match(g.Groups[1].Value, "\"errors\":(\\d+)"));
                }
            }
            return st;
        }

        static long Num(Match m) { return m.Success ? Convert.ToInt64(m.Groups[1].Value) : 0; }

        static int HttpGet(string url, int timeoutMs, out string body)
        {
            body = null;
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(url);
                req.Method = "GET";
                req.Timeout = timeoutMs;
                req.ReadWriteTimeout = timeoutMs;
                req.Proxy = null;
                using (var resp = (HttpWebResponse)req.GetResponse())
                using (var rs = resp.GetResponseStream())
                using (var sr = new StreamReader(rs, Encoding.UTF8))
                {
                    body = sr.ReadToEnd();
                    return (int)resp.StatusCode;
                }
            }
            catch (WebException we)
            {
                var resp = we.Response as HttpWebResponse;
                return resp != null ? (int)resp.StatusCode : 0;
            }
            catch { return 0; }
        }

        void ApplyStatus(StatusInfo st)
        {
            if (st == null) return;
            string chip; Color dot;
            if (!st.Alive)
            {
                bool starting = st.State == "starting";
                dot = starting ? Theme.Warn : Theme.Err;
                chip = starting ? "重连中" : "已停止";
                _tray.Icon = starting ? _iconStop : _iconFail;
            }
            else
            {
                dot = Theme.Ok;
                chip = st.NeedAuth ? "需令牌" : "运行中";
                _tray.Icon = _iconRun;
            }
            _mini.ApplyStatus(st, chip, dot);
            _tray.Text = "model-gateway · " + chip;
        }

        // ---------- 进程管理 ----------
        public void StartGateway()
        {
            if (_proc != null)
            {
                bool alive;
                try { alive = !_proc.HasExited; } catch { alive = false; }
                if (alive) return;
            }
            FreePort(_port);
            string node = FindNode();
            if (node == null || !File.Exists(Path.Combine(_root, "src", "index.js")))
            {
                MessageBox.Show("未找到 node.exe 或 src/index.js。\n请把 mg-tray.exe 放在 model-gateway 项目根目录使用。",
                    "model-gateway", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            var psi = new ProcessStartInfo
            {
                FileName = node,
                Arguments = "src/index.js",
                WorkingDirectory = _root,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            _stopping = false;
            _fastFails = 0;
            _startedAt = DateTime.Now;
            _proc = Process.Start(psi);
            _proc.EnableRaisingEvents = true;
            // 网关日志已落 logs/gateway-*.log，子进程控制台输出直接丢弃
            _proc.OutputDataReceived += delegate { };
            _proc.ErrorDataReceived += delegate { };
            _proc.BeginOutputReadLine();
            _proc.BeginErrorReadLine();
            _proc.Exited += ProcExited;
        }

        void ProcExited(object sender, EventArgs e)
        {
            if (_stopping) return;
            var lifeMs = (long)(DateTime.Now - _startedAt).TotalMilliseconds;
            _fastFails = lifeMs < 10000 ? _fastFails + 1 : 0;
            if (_fastFails >= 5)
            {
                try { _mini.BeginInvoke((MethodInvoker)delegate {
                    _tray.ShowBalloonTip(4000, "model-gateway", "连续启动失败，已停止自动重启；请打开日志排查。", ToolTipIcon.Error);
                }); } catch { }
                return;
            }
            // 看门狗：5s 后自动拉活（退避由快速失败计数兜底）
            System.Threading.Timer t = null;
            t = new System.Threading.Timer(delegate
            {
                if (t != null) t.Dispose();
                if (_stopping) return;
                try { _mini.BeginInvoke((MethodInvoker)delegate { StartGateway(); }); } catch { }
            }, null, 5000, Timeout.Infinite);
        }

        public void StopGateway()
        {
            _stopping = true;
            try { if (_proc != null && !_proc.HasExited) { _proc.Kill(); _proc.WaitForExit(3000); } } catch { }
            _proc = null;
            FreePort(_port); // 兜底：清掉孤儿/外部 node
        }

        public void RestartGateway()
        {
            StopGateway();
            _stopping = false;
            StartGateway();
        }

        // 清占用端口的残留 node 进程（同 start.bat 的 netstat→taskkill 逻辑，只杀 node.exe）
        void FreePort(int port)
        {
            try
            {
                var psi = new ProcessStartInfo("netstat", "-ano")
                {
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    CreateNoWindow = true,
                };
                string output;
                using (var p = Process.Start(psi))
                {
                    output = p.StandardOutput.ReadToEnd();
                    p.WaitForExit(3000);
                }
                string suffix = ":" + port;
                foreach (var line in output.Split('\n'))
                {
                    if (line.IndexOf("LISTENING", StringComparison.OrdinalIgnoreCase) < 0) continue;
                    var parts = line.Trim().Split(new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
                    if (parts.Length < 5 || !parts[1].EndsWith(suffix, StringComparison.OrdinalIgnoreCase)) continue;
                    int pid;
                    if (!int.TryParse(parts[parts.Length - 1], out pid) || pid <= 0) continue;
                    try
                    {
                        var pr = Process.GetProcessById(pid);
                        if (pr.ProcessName.Equals("node", StringComparison.OrdinalIgnoreCase))
                        {
                            pr.Kill();
                            pr.WaitForExit(2000);
                        }
                    }
                    catch { }
                }
            }
            catch { }
        }

        static string FindNode()
        {
            string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string pf86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
            string[] candidates = new string[] {
                Path.Combine(pf, "nodejs", "node.exe"),
                Path.Combine(pf86, "nodejs", "node.exe"),
            };
            foreach (var c in candidates) if (File.Exists(c)) return c;
            var path = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (var dir in path.Split(';'))
            {
                try { var p = Path.Combine(dir.Trim(), "node.exe"); if (File.Exists(p)) return p; }
                catch { }
            }
            return null;
        }

        // ---------- 自启 / 面板 / 日志 ----------
        public bool GetAutoStart()
        {
            try
            {
                using (var k = Registry.CurrentUser.OpenSubKey(RunKeyPath))
                    return k != null && k.GetValue(RunValueName) != null;
            }
            catch { return false; }
        }

        public void SetAutoStart(bool on)
        {
            try
            {
                using (var k = Registry.CurrentUser.CreateSubKey(RunKeyPath))
                {
                    if (on) k.SetValue(RunValueName, "\"" + Application.ExecutablePath + "\"");
                    else k.DeleteValue(RunValueName, false);
                }
            }
            catch (Exception ex) { MessageBox.Show("设置自启失败：" + ex.Message, "model-gateway"); }
        }

        public void OpenPanel()
        {
            try { Process.Start("http://127.0.0.1:" + _port + "/"); } catch { }
        }

        public void OpenLogs()
        {
            try
            {
                var dir = Path.Combine(_root, "logs");
                if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
                Process.Start("explorer.exe", dir);
            }
            catch { }
        }

        public void ShowMini()
        {
            _mini.Show();
            _mini.Activate();
        }

        public void ExitApp()
        {
            var r = MessageBox.Show("退出托盘将停止 model-gateway 网关进程，确定退出？",
                "model-gateway", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
            if (r != DialogResult.Yes) return;
            StopGateway();
            _poll.Stop();
            _tray.Visible = false;
            _tray.Dispose();
            _mini.ForceClose = true;
            _mini.Close();
            Application.Exit();
        }

        ContextMenuStrip BuildMenu()
        {
            var menu = new ContextMenuStrip();
            var miPanel = new ToolStripMenuItem("打开面板");
            miPanel.Click += delegate { OpenPanel(); };
            var miMini = new ToolStripMenuItem("显示悬浮小窗");
            miMini.Click += delegate { ShowMini(); };
            var miStart = new ToolStripMenuItem("启动");
            miStart.Click += delegate { StartGateway(); };
            var miStop = new ToolStripMenuItem("停止");
            miStop.Click += delegate { StopGateway(); };
            var miRestart = new ToolStripMenuItem("重启");
            miRestart.Click += delegate { RestartGateway(); };
            var miAuto = new ToolStripMenuItem("开机自启");
            miAuto.Checked = GetAutoStart();
            miAuto.Click += delegate
            {
                bool now = !miAuto.Checked;
                SetAutoStart(now);
                miAuto.Checked = GetAutoStart();
            };
            var miLog = new ToolStripMenuItem("打开日志文件夹");
            miLog.Click += delegate { OpenLogs(); };
            var miExit = new ToolStripMenuItem("退出");
            miExit.Click += delegate { ExitApp(); };
            menu.Items.AddRange(new ToolStripItem[] {
                miPanel, miMini, new ToolStripSeparator(),
                miStart, miStop, miRestart, new ToolStripSeparator(),
                miAuto, miLog, new ToolStripSeparator(), miExit,
            });
            return menu;
        }

        static Icon MakeIcon(Color dot)
        {
            using (var bmp = new Bitmap(16, 16))
            {
                using (var g = Graphics.FromImage(bmp))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.Clear(Theme.TermBg);
                    using (var b = new SolidBrush(dot)) g.FillEllipse(b, 4, 4, 8, 8);
                }
                return Icon.FromHandle(bmp.GetHicon());
            }
        }
    }

    // 悬浮小窗 = 面板同款「卡片」：外圈 sink 底 + 硬偏移阴影 + 2px 描边圆角卡；
    // 标题（Bahnschrift，GATE 走 accent）+ 健康徽章（dot+chip）+ gem 菱形 kv 行 + 胶囊按钮排。
    // ✕ 缩托盘；右键菜单切置顶/退出。数据更新仅改字段 + Invalidate，全部内容在 OnPaint 绘制。
    // 悬浮小窗（极简三数据版）：运行状态(运行中/重连中/已停止) + 当前使用的模型 + 今日 token 总量。
    // 布局按 DPI 缩放（Mg.X），文字原生渲染不发虚；✕ 缩托盘；右键菜单切置顶/退出。
    internal class MiniForm : Form
    {
        readonly TrayApp _app;
        public bool ForceClose;
        bool _dragging;
        Point _dragOff;
        ContextMenuStrip _ctx;

        string _stateText = "连接中…";
        Color _stateDot = Theme.Ink3;
        bool _alive, _statsOk, _needAuth, _owned;
        long _todayTokens;
        string _curModel;

        readonly Font _fState = new Font("Segoe UI", 12.5f, FontStyle.Bold);
        readonly Font _fVal = MgFonts.Mono(11.5f);
        readonly Font _fLab = MgFonts.Mono(9.5f);
        readonly Font _fSub = MgFonts.Mono(8.5f);
        readonly Font _fMark = MgFonts.Mark(11.5f);

        public MiniForm(TrayApp app)
        {
            _app = app;
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            var wa = Screen.PrimaryScreen.WorkingArea;
            Location = new Point(wa.Right - Mg.X(330), wa.Bottom - Mg.X(194));
            Size = new Size(Mg.X(304), Mg.X(164));
            BackColor = Theme.Card;
            DoubleBuffered = true;
            TopMost = true;
            Font = MgFonts.Mono(9.5f);

            var bStart = new MgButton("启动", Mg.X(14), Mg.X(120), Mg.X(52), Mg.X(28), 0); bStart.Click += delegate { _app.StartGateway(); };
            var bStop = new MgButton("停止", Mg.X(70), Mg.X(120), Mg.X(52), Mg.X(28), 1); bStop.Click += delegate { _app.StopGateway(); };
            var bRestart = new MgButton("重启", Mg.X(126), Mg.X(120), Mg.X(52), Mg.X(28), 1); bRestart.Click += delegate { _app.RestartGateway(); };
            var bPanel = new MgButton("面板", Mg.X(182), Mg.X(120), Mg.X(52), Mg.X(28), 0); bPanel.Click += delegate { _app.OpenPanel(); };
            var bLogs = new MgButton("日志", Mg.X(238), Mg.X(120), Mg.X(52), Mg.X(28), 1); bLogs.Click += delegate { _app.OpenLogs(); };
            var bClose = new MgButton("✕", Mg.X(274), Mg.X(8), Mg.X(24), Mg.X(24), 2); bClose.Click += delegate { Hide(); };
            Controls.AddRange(new Control[] { bStart, bStop, bRestart, bPanel, bLogs, bClose });

            _ctx = new ContextMenuStrip();
            var miTop = new ToolStripMenuItem("置顶显示");
            miTop.Checked = true;
            miTop.Click += delegate
            {
                TopMost = !TopMost;
                miTop.Checked = TopMost;
            };
            var miPanel = new ToolStripMenuItem("打开面板");
            miPanel.Click += delegate { _app.OpenPanel(); };
            var miHide = new ToolStripMenuItem("隐藏到托盘");
            miHide.Click += delegate { Hide(); };
            var miExit = new ToolStripMenuItem("退出托盘");
            miExit.Click += delegate { _app.ExitApp(); };
            _ctx.Items.AddRange(new ToolStripItem[] { miTop, new ToolStripSeparator(), miPanel, miHide, new ToolStripSeparator(), miExit });
            ContextMenuStrip = _ctx;

            // 无边框拖动：空白区按住即可拖（按钮控件自行处理点击，不参与）
            MouseDown += DragStart; MouseMove += DragMove; MouseUp += DragEnd;

            // 状态点呼吸重绘
            var pulse = new System.Windows.Forms.Timer { Interval = 500 };
            pulse.Tick += delegate { if (_alive && Visible) Invalidate(); };
            pulse.Start();
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            // Win11 系统圆角 + 阴影；Win10 无此属性时回退 Region 硬圆角
            try
            {
                int pref = 2; // DWMWCP_ROUND
                int hr = Mg.DwmSetWindowAttribute(Handle, 33, ref pref, 4);
                if (hr != 0) Region = new Region(Mg.RoundRect(new Rectangle(Point.Empty, Size), Mg.X(12)));
            }
            catch { Region = new Region(Mg.RoundRect(new Rectangle(Point.Empty, Size), Mg.X(12))); }
        }

        void Put(Graphics g, ref int cx, int y, string s, Color c, Font f)
        {
            TextRenderer.DrawText(g, s, f, new Point(cx, y), c, TextFormatFlags.NoPadding);
            cx += TextRenderer.MeasureText(g, s, f).Width;
        }

        // 模型名可能超宽：按可用宽度截断加 …
        string Truncate(Graphics g, string s, Font f, int maxW)
        {
            if (TextRenderer.MeasureText(g, s, f).Width <= maxW) return s;
            while (s.Length > 1 && TextRenderer.MeasureText(g, s + "…", f).Width > maxW) s = s.Substring(0, s.Length - 1);
            return s + "…";
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using (var pen = new Pen(Theme.Edge))
            using (var p = Mg.RoundRect(new Rectangle(0, 0, Width - 1, Height - 1), Mg.X(12)))
            {
                g.DrawPath(pen, p);
            }

            // 标题：MODEL·(ink) GATE(accent)
            int tx = Mg.X(14);
            Put(g, ref tx, Mg.X(8), "MODEL·", Theme.Ink, _fMark);
            Put(g, ref tx, Mg.X(8), "GATE", Theme.Accent, _fMark);

            // hero：呼吸状态点 + 状态词；右侧 守护/未接管
            int hy = Mg.X(34);
            int dcx = Mg.X(22), dcy = Mg.X(42);
            if (_alive)
            {
                int pr = Mg.X(4) + ((Environment.TickCount / 500) % 2) * Mg.X(2);
                using (var b = new SolidBrush(Color.FromArgb(70, _stateDot)))
                {
                    g.FillEllipse(b, dcx - pr, dcy - pr, pr * 2, pr * 2);
                }
            }
            using (var b = new SolidBrush(_stateDot))
            {
                g.FillEllipse(b, dcx - Mg.X(4), dcy - Mg.X(4), Mg.X(8), Mg.X(8));
            }
            TextRenderer.DrawText(g, _stateText, _fState, new Point(Mg.X(34), Mg.X(32)), Theme.Ink);
            string mode = _owned ? "守护中" : "未接管";
            var mw = TextRenderer.MeasureText(g, mode, _fSub).Width;
            TextRenderer.DrawText(g, mode, _fSub, new Point(Width - Mg.X(14) - mw, Mg.X(38)), Theme.Ink3);
            if (_needAuth)
            {
                var nw = TextRenderer.MeasureText(g, "需令牌", _fSub).Width;
                TextRenderer.DrawText(g, "需令牌", _fSub, new Point(Width - Mg.X(14) - mw - nw - Mg.X(8), Mg.X(38)), Theme.Warn);
            }

            // 三数据卡：当前模型 / 今日 token（card2 底分层，无描边）
            var card = new Rectangle(Mg.X(14), Mg.X(60), Width - Mg.X(28), Mg.X(52));
            using (var b = new SolidBrush(Theme.Card2))
            using (var p = Mg.RoundRect(card, Mg.X(8)))
            {
                g.FillPath(b, p);
            }
            bool hasStats = _alive && _statsOk;
            int lx = Mg.X(26), vx = Mg.X(110);
            int avail = Width - vx - Mg.X(16);
            TextRenderer.DrawText(g, "当前模型", _fLab, new Point(lx, Mg.X(68)), Theme.Ink3, TextFormatFlags.NoPadding);
            string model = hasStats ? (string.IsNullOrEmpty(_curModel) ? "—" : _curModel) : "—";
            TextRenderer.DrawText(g, Truncate(g, model, _fVal, avail), _fVal, new Point(vx, Mg.X(66)), Theme.Accent, TextFormatFlags.NoPadding);
            TextRenderer.DrawText(g, "今日", _fLab, new Point(lx, Mg.X(88)), Theme.Ink3, TextFormatFlags.NoPadding);
            string tokStr = hasStats ? FmtTok(_todayTokens) : "—";
            TextRenderer.DrawText(g, tokStr, _fVal, new Point(vx, Mg.X(86)), Theme.Ink, TextFormatFlags.NoPadding);
            var tw2 = TextRenderer.MeasureText(g, tokStr, _fVal).Width;
            TextRenderer.DrawText(g, "TOKENS", _fSub, new Point(vx + tw2 + Mg.X(6), Mg.X(90)), Theme.Ink3, TextFormatFlags.NoPadding);
        }

        public void ApplyStatus(StatusInfo st, string stateText, Color stateDot)
        {
            _stateText = (st.Alive && st.NeedAuth) ? "运行中" : stateText;
            _stateDot = stateDot;
            _alive = st.Alive;
            _statsOk = st.StatsOk;
            _needAuth = st.NeedAuth;
            _owned = st.Owned;
            _todayTokens = st.TodayTokens;
            _curModel = st.CurModel;
            Invalidate();
        }

        static string FmtTok(long n)
        {
            if (n >= 100000000) return Math.Round(n / 100000000.0, 1) + "亿";
            if (n >= 10000) return Math.Round(n / 10000.0, 1) + "万";
            return n.ToString();
        }

        void DragStart(object sender, MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left) { _dragging = true; _dragOff = e.Location; }
        }
        void DragMove(object sender, MouseEventArgs e)
        {
            if (!_dragging) return;
            var p = PointToScreen(e.Location);
            Location = new Point(p.X - _dragOff.X, p.Y - _dragOff.Y);
        }
        void DragEnd(object sender, MouseEventArgs e) { _dragging = false; }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            // ✕ / Alt+F4 一律缩托盘；真正退出只走「退出托盘」菜单
            if (!ForceClose && e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                Hide();
                return;
            }
            base.OnFormClosing(e);
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            // 保持屏幕工作区内（拖出界/分辨率变化后）
            var wa = Screen.PrimaryScreen.WorkingArea;
            if (Right > wa.Right) Left = wa.Right - Width;
            if (Bottom > wa.Bottom) Top = wa.Bottom - Height;
            if (Left < wa.Left) Left = wa.Left;
            if (Top < wa.Top) Top = wa.Top;
        }
    }
}
