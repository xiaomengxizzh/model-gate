// mg-tray.cs — model-gateway 托盘 + 悬浮小窗管理器（零第三方依赖：Windows 自带 .NET Framework 编译运行）
// 编译：scripts\tray\build.cmd → 项目根 mg-tray.exe；双击运行，无控制台窗口。
// 职责：拉起/守护 node src/index.js（崩溃 5s 退避自动拉活，连续快速失败熔断）、
//       悬浮小窗显示状态与快捷操作、托盘常驻、开机自启（HKCU Run）、启动前清端口残留 node（同 start.bat 语义）。
// 外观：赛璐璐 = gate-model 控制面板（admin.html dark）同源配色（--sink/--card/--card2/--edge/--cel-accent），
//       Form.Opacity 整体半透明（0.9）；两列布局，卡内左右排布（同字号）：
//       状态词即标题（有流量点亮「传输中」）+ 两列数据卡 + 主次分组按钮（primary 随运行态切换）。
//       中文萝莉体（用户级字体，回退雅黑），西文/数字 Cascadia Mono，小字号 + 大间距留呼吸感。
// 语法约束：in-box csc.exe 仅支持 C# 5——不得使用 $"" / ?. / out var / using var / nameof。
using System;
using System.Collections.Generic;
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

    // 赛璐璐配色 = gate-model 自己的控制面板（admin.html [data-theme="dark"]）真值，严格同源
    static class Theme
    {
        public static readonly Color Sink = Color.FromArgb(0x10, 0x1A, 0x4E);      // --sink
        public static readonly Color Card = Color.FromArgb(0x1B, 0x25, 0x66);      // --card
        public static readonly Color Card2 = Color.FromArgb(0x1D, 0x2A, 0x72);     // --card2
        public static readonly Color Card3 = Color.FromArgb(0x14, 0x1D, 0x55);     // --card3
        public static readonly Color Edge = Color.FromArgb(0x3D, 0x4D, 0xAB);      // --edge
        public static readonly Color Shadow = Color.FromArgb(0x0A, 0x12, 0x36);    // --shadow
        public static readonly Color Ink = Color.FromArgb(0xEE, 0xF1, 0xFF);       // --ink
        public static readonly Color Ink2 = Color.FromArgb(0xCF, 0xDC, 0xFF);      // --ink2
        public static readonly Color Ink3 = Color.FromArgb(0xA4, 0xB0, 0xF2);      // --ink3
        public static readonly Color Accent = Color.FromArgb(0x86, 0xA0, 0xFF);    // --cel-accent
        public static readonly Color Mark = Color.FromArgb(0x38, 0x66, 0xC8);      // --mark
        public static readonly Color AccentH = Color.FromArgb(0x9C, 0xB0, 0xFF);     // accent 悬停
        public static readonly Color AccentD = Color.FromArgb(0x7A, 0x90, 0xF0);     // accent 按压
        public static readonly Color Card2H = Color.FromArgb(0x26, 0x32, 0x7E);     // 卡2悬停
        public static readonly Color TermBg = Color.FromArgb(0x0A, 0x0E, 0x24);    // --term-bg
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
        // 中文走萝莉体（用户级安装，字族名=萝莉体 第二版），缺失回退雅黑；mono 字体无中文字形严禁配中文
        static readonly string CnName = Has("萝莉体 第二版") ? "萝莉体 第二版" : "Microsoft YaHei UI";
        public static Font Mono(float size) { return new Font(MonoName, size * Mg.Scale); }
        public static Font Mark(float size) { return new Font(MarkName, size * Mg.Scale, FontStyle.Bold); }
        public static Font Cn(float size) { return new Font(CnName, size * Mg.Scale); }
        public static Font CnBold(float size) { return new Font(CnName, size * Mg.Scale, FontStyle.Bold); }
    }

    static class Mg
    {
        // DPI 缩放系数（Main 里按主屏 DpiX 设定）；X() 把 96dpi 设计稿坐标换算到实际 DPI
        public static float Scale = 1f;
        public static int X(int v) { return (int)Math.Round(v * Scale); }

        [DllImport("dwmapi.dll")]
        public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

        [DllImport("user32.dll")] public static extern bool ReleaseCapture();
        [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam);

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

    // 虚拟按钮（MiniForm 自绘 + 命中检测，不挂真实子控件）：
    // kind: 0=Primary(accent 填充) 1=Ghost(card2 半透明填充+1px 边) 2=Mini(✕ 平时淡化、悬停红)
    internal class MgButton
    {
        public Rectangle Rect; public string Text; public int Kind;
        public bool Hot, Down; public EventHandler Click;

        public MgButton(string text, int x, int y, int w, int h, int kind)
        {
            Text = text;
            Rect = new Rectangle(x, y, w, h);
            Kind = kind;
        }

        // primary 跟随运行态切换（启动/停止谁主推）
        public void SetKind(int kind) { Kind = kind; }

        public void Paint(Graphics g)
        {
            var r = Rect; r.Width -= 1; r.Height -= 1;
            Color fill = Kind == 0
                ? (Down ? Theme.AccentD : (Hot ? Theme.AccentH : Theme.Accent))
                : (Kind == 2
                    ? (Hot ? Color.FromArgb(60, Theme.Err) : Color.FromArgb(150, Theme.Card2))
                    : (Hot ? Color.FromArgb(200, Theme.Card2H) : Color.FromArgb(150, Theme.Card2)));
            using (var p = Mg.RoundRect(r, Mg.X(10)))
            {
                using (var b = new SolidBrush(fill)) g.FillPath(b, p);
                if (Kind == 1 || Kind == 2)
                {
                    using (var pen = new Pen(Kind == 2 && Hot ? Theme.Err : Theme.Edge)) g.DrawPath(pen, p);
                }
            }
            Color txt = Kind == 0
                ? Color.White
                : (Kind == 2 ? (Hot ? Theme.Err : Theme.Ink2)
                              : (Hot ? Theme.Ink : Theme.Ink2));
            using (var b = new SolidBrush(txt))
            using (var sf = (StringFormat)StringFormat.GenericTypographic.Clone())
            {
                sf.Alignment = StringAlignment.Center;
                sf.LineAlignment = StringAlignment.Center;
                g.DrawString(Text, MgFonts.Cn(9.5f), b, new RectangleF(Rect.X, Rect.Y - Mg.X(1), Rect.Width, Rect.Height), sf);
            }
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
        public string Upstream;   // 最近一次成功服务的上游 provider（lastServing.provider）
        public string DirModel;   // defaults.directory 首个模型（当前模型不在价表时的兜底取价对象）
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

        string _adminToken = "";  // 管理 API 令牌（ReadAdminToken），/api/status 拉数据用

        // ---------- 价格卡数据（上游定价表，10 分钟刷新）----------
        // 模型 id -> [生效输入价, 生效输出价, 生效缓存读价]（元/M）。后台线程写、UI 线程读：
        // 引用赋值原子，string 不可变，读侧无需加锁。null=尚未取到/取不到（无 key、网络失败）
        public volatile System.Collections.Generic.Dictionary<string, string[]> PriceTable;
        readonly System.Threading.Timer _priceTimer;

        public TrayApp()
        {
            _port = ReadPort();
            _adminToken = ReadAdminToken();
            _priceTimer = new System.Threading.Timer(delegate { FetchPrices(); }, null, 3000, 600000);
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

        // 管理令牌获取链：config/admin.token（托盘专用导出文件）→ HKCU/进程 env → server.adminToken → keys.local.json 明文兜底
        string ReadAdminToken()
        {
            try
            {
                var p = Path.Combine(_root, "config", "admin.token");
                if (File.Exists(p))
                {
                    var v = File.ReadAllText(p).Trim();
                    if (v.Length > 0 && !v.StartsWith("MG1:")) return v;
                }
            }
            catch { }
            try
            {
                var v = Registry.GetValue("HKEY_CURRENT_USER\\Environment", "MG_ADMIN_TOKEN", null) as string;
                if (!string.IsNullOrEmpty(v)) return v.Trim();
            }
            catch { }
            try
            {
                var v = Environment.GetEnvironmentVariable("MG_ADMIN_TOKEN");
                if (!string.IsNullOrEmpty(v)) return v.Trim();
            }
            catch { }
            try
            {
                var cfg = File.ReadAllText(Path.Combine(_root, "config", "gateway.json"));
                var m = Regex.Match(cfg, "\"adminToken\"\\s*:\\s*\"([^\"]+)\"");
                if (m.Success) return m.Groups[1].Value.Trim();
            }
            catch { }
            try
            {
                var kf = File.ReadAllText(Path.Combine(_root, "config", "keys.local.json"));
                if (!kf.TrimStart().StartsWith("MG1:"))
                {
                    var m2 = Regex.Match(kf, "\"__mg_admin\"\\s*:\\s*\"([^\"]+)\"");
                    if (m2.Success) return m2.Groups[1].Value.Trim();
                }
            }
            catch { }
            return "";
        }

        // ---------- 价格表拉取（上游 /v1/models；失败静默保旧值，不打扰 UI）----------
        void FetchPrices()
        {
            try
            {
                // baseUrl/apiKeyEnv 从 gateway.local.json 的 jiyuan 段读（baseUrl 在该对象首个 } 之前），缺省走 tokenrhythm/JIYUAN_API_KEY
                string baseUrl = "https://tokenrhythm.studio", keyEnv = "JIYUAN_API_KEY";
                try
                {
                    var cfg = File.ReadAllText(Path.Combine(_root, "config", "gateway.local.json"));
                    var mb = Regex.Match(cfg, "\"jiyuan\"\\s*:\\s*\\{[^{}]*?\"baseUrl\"\\s*:\\s*\"([^\"]+)\"");
                    if (mb.Success) baseUrl = mb.Groups[1].Value.TrimEnd('/');
                    var mk = Regex.Match(cfg, "\"jiyuan\"\\s*:\\s*\\{[^{}]*?\"apiKeyEnv\"\\s*:\\s*\"([^\"]+)\"");
                    if (mk.Success) keyEnv = mk.Groups[1].Value;
                }
                catch { }
                var key = Environment.GetEnvironmentVariable(keyEnv);
                if (string.IsNullOrEmpty(key)) return;
                string body = HttpGetBody(baseUrl + "/v1/models", key);
                if (body == null) return;
                var table = new System.Collections.Generic.Dictionary<string, string[]>();
                var ids = Regex.Matches(body, "\"id\"\\s*:\\s*\"([^\"]+)\"");
                for (int i = 0; i < ids.Count; i++)
                {
                    int start = ids[i].Index + ids[i].Length;
                    int end = i + 1 < ids.Count ? ids[i + 1].Index : body.Length;
                    string chunk = body.Substring(start, end - start);
                    // 生效价（折扣后）只出现在模型对象顶层，嵌套 pricing 子对象键名不同，不会误取
                    string fi = Regex.Match(chunk, "\"effective_input_price_per_million\"\\s*:\\s*\"([^\"]+)\"").Groups[1].Value;
                    string fo = Regex.Match(chunk, "\"effective_output_price_per_million\"\\s*:\\s*\"([^\"]+)\"").Groups[1].Value;
                    string fc = Regex.Match(chunk, "\"effective_cache_read_price_per_million\"\\s*:\\s*\"([^\"]+)\"").Groups[1].Value;
                    if (fi != "" && fo != "")
                        table[ids[i].Groups[1].Value] = new string[] { TrimZ(fi), TrimZ(fo), fc == "" ? "—" : TrimZ(fc) };
                }
                if (table.Count > 0) PriceTable = table;
            }
            catch { }
        }

        static string TrimZ(string v)
        {
            try { return decimal.Parse(v, System.Globalization.CultureInfo.InvariantCulture).ToString("0.############", System.Globalization.CultureInfo.InvariantCulture); }
            catch { return v; }
        }

        // 直连优先（国内可达），失败走本机 Clash 代理重试
        string HttpGetBody(string url, string key)
        {
            string first = HttpGetRaw(url, key, false);
            if (first != null) return first;
            return HttpGetRaw(url, key, true);
        }

        string HttpGetRaw(string url, string key, bool viaProxy)
        {
            try
            {
                try { ServicePointManager.SecurityProtocol |= (SecurityProtocolType)3072; } catch { } // TLS 1.2（4.0 引用程序集无具名成员，数字转）
                var req = (HttpWebRequest)WebRequest.Create(url);
                req.Method = "GET";
                req.Timeout = 8000; req.ReadWriteTimeout = 8000;
                req.Headers[HttpRequestHeader.Authorization] = "Bearer " + key;
                req.Proxy = viaProxy ? new WebProxy("http://127.0.0.1:7890") : null;
                using (var resp = (HttpWebResponse)req.GetResponse())
                using (var rs = resp.GetResponseStream())
                using (var sr = new StreamReader(rs, Encoding.UTF8))
                    return sr.ReadToEnd();
            }
            catch { return null; }
        }

        // ---------- 状态轮询 ----------
        void PollTick(object sender, EventArgs e)
        {
            int port = _port;
            Task.Factory.StartNew(delegate
            {
                var st = PollOnce(port);
                try { _mini.BeginInvoke((MethodInvoker)delegate { ApplyStatus(st); AutoGuard(st); }); } catch { }
            });
        }

        // 守护兜底：网关不在跑、也非人为停止、且无属主进程（孤儿死亡/开机未启动）→ 自动拉起，
        // 任何情况下都不需要人手动点启动；只有用户点过「停止」（_stopping）才保持停止
        void AutoGuard(StatusInfo st)
        {
            if (!st.Alive && !_stopping && _proc == null) StartGateway();
        }

        StatusInfo PollOnce(int port)
        {
            var st = new StatusInfo();
            st.Owned = _proc != null;
            try { st.Owned = st.Owned && _proc.HasExited == false; }
            catch { st.Owned = false; }
            string body;
            int code = HttpGet("http://127.0.0.1:" + port + "/healthz", 1500, null, out body);
            st.Alive = code == 200;
            if (!st.Alive)
            {
                st.State = (st.Owned && _fastFails < 5) ? "starting" : "stopped";
                return st;
            }
            st.State = "running";
            string auth = _adminToken.Length > 0 ? "Bearer " + _adminToken : null;
            code = HttpGet("http://127.0.0.1:" + port + "/api/status", 1500, auth, out body);
            if (code == 401) { st.NeedAuth = true; return st; }
            if (code == 200 && body != null)
            {
                st.StatsOk = true;
                st.UptimeMs = Num(Regex.Match(body, "\"uptimeMs\":(\\d+)"));
                st.TodayTokens = Num(Regex.Match(body, "\"todayTokens\":(\\d+)"));
                // 当前使用的模型/上游：网关记录最近一次成功服务的 serving（index.js 数据面回写）
                var msrv = Regex.Match(body, "\"lastServing\":\\{\"model\":\"([^\"]*)\",\"provider\":\"([^\"]*)\"");
                if (msrv.Success)
                {
                    st.CurModel = msrv.Groups[1].Value;
                    st.Upstream = msrv.Groups[2].Value;
                }
                else
                {
                    msrv = Regex.Match(body, "\"lastServing\":\\{\"model\":\"([^\"]*)\"");
                    if (msrv.Success) st.CurModel = msrv.Groups[1].Value;
                }
                // global 对象里 requests/errors 位于嵌套 latTrend 之前，截到第一个 } 前已含所需字段
                var g = Regex.Match(body, "\"global\":\\{([^}]*)\\}");
                if (g.Success)
                {
                    st.Requests = Num(Regex.Match(g.Groups[1].Value, "\"requests\":(\\d+)"));
                    st.Errors = Num(Regex.Match(g.Groups[1].Value, "\"errors\":(\\d+)"));
                }
                // defaults.directory 首个模型（buildStatus 里 defaults 内 directory 是首键）——价格卡的兜底取价对象
                var dm = Regex.Match(body, "\"defaults\":\\{\"directory\":\\[\\{\"model\":\"([^\"]+)\"");
                if (dm.Success) st.DirModel = dm.Groups[1].Value;
            }
            return st;
        }

        static long Num(Match m) { return m.Success ? Convert.ToInt64(m.Groups[1].Value) : 0; }

        static int HttpGet(string url, int timeoutMs, string auth, out string body)
        {
            body = null;
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(url);
                req.Method = "GET";
                req.Timeout = timeoutMs;
                req.ReadWriteTimeout = timeoutMs;
                req.Proxy = null;
                if (!string.IsNullOrEmpty(auth)) req.Headers[HttpRequestHeader.Authorization] = auth;
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
            _mini.ShowRestarting();   // 即时反馈：重启进行中，下一轮 poll（≤2s）刷新为实际状态
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
                    g.Clear(Color.Transparent);
                    // 赛璐璐小卡：钴蓝圆角底 + 描边，中央状态点
                    using (var p = Mg.RoundRect(new Rectangle(0, 0, 14, 14), 4))
                    {
                        using (var b = new SolidBrush(Theme.Card)) g.FillPath(b, p);
                        using (var pen = new Pen(Theme.Edge)) g.DrawPath(pen, p);
                    }
                    using (var b = new SolidBrush(dot)) g.FillEllipse(b, 5, 5, 6, 6);
                }
                return Icon.FromHandle(bmp.GetHicon());
            }
        }
    }

    // 悬浮小窗（赛璐璐半透明）：状态词即标题（呼吸点；有流量点亮「传输中」accent）
    // + 副标题（model-gateway :端口 · 守护中/未接管）+ 两列数据卡（当前模型｜今日 TOKENS）
    // + 主次分组按钮排（进程组｜跳转组，primary 随运行态在 启动/停止 间切换）。
    // 透明：Form.Opacity 整体半透明（0.9，WinForms 自动套 layered+LWA_ALPHA）+ Win11 DWM 圆角，
    // 桌面背景透出；按钮为窗口内虚拟绘制 + 鼠标命中检测。
    // 中文萝莉体、西文/数字 Cascadia Mono；✕ 缩托盘；右键菜单切置顶/退出。
    internal class MiniForm : Form
    {
        readonly TrayApp _app;
        public bool ForceClose;
        ContextMenuStrip _ctx;
        List<MgButton> _btns;
        MgButton _bStart, _bStop;

        string _stateText = "连接中…";
        Color _stateDot = Theme.Ink3;
        bool _alive, _statsOk;
        long _todayTokens;
        long _lastTok = -1;       // 上轮 todayTokens（传输中检测）
        long _lastReq = -1;       // 上轮 requests
        string _curModel;
        string _curUpstream;
        string _dirModel;         // defaults.directory 首个模型（价格卡兜底取价对象）

        readonly Font _fState = MgFonts.CnBold(12f);
        readonly Font _fLab = MgFonts.Cn(8.5f);     // 卡内标签：四卡共享三卡空间后字号缩小
        readonly Font _fVal = MgFonts.Cn(8.5f);     // 卡内数值：同一只字体，杜绝大小不一

        public MiniForm(TrayApp app)
        {
            _app = app;
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            var wa = Screen.PrimaryScreen.WorkingArea;
            // 两列严格对齐：顶线 y=16（运行中=启动按钮顶），底线 y=220（词元卡底=日志按钮底），
            // 窗高 236 = 16 + 204 + 16；默认出现在屏幕右下角
            Location = new Point(wa.Right - Mg.X(340), wa.Bottom - Mg.X(256));
            Size = new Size(Mg.X(320), Mg.X(236));
            TopMost = true;
            DoubleBuffered = true;
            Opacity = 0.8;   // 整体半透明：Form.Opacity，WinForms 自动套 WS_EX_LAYERED+LWA_ALPHA
            // 窗口图标与 exe/托盘同款（赛璐璐 ico 嵌在 exe 资源里）
            try { Icon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
            Font = MgFonts.Cn(10f);

            // 窗控（右上角）：最小到托盘 / 关闭，32×32 与左列按钮同高（两者都缩托盘，网关不受影响）
            var bMin = new MgButton("—", Mg.X(236), Mg.X(16), Mg.X(32), Mg.X(32), 2); bMin.Click += delegate { Hide(); };
            var bClose = new MgButton("×", Mg.X(272), Mg.X(16), Mg.X(32), Mg.X(32), 2); bClose.Click += delegate { Hide(); };

            // 左列：等宽等高按钮 y=16/59/102/145/188（步长 43），日志底 220 与词元卡底严格对齐
            _bStart = new MgButton("启动", Mg.X(16), Mg.X(16), Mg.X(64), Mg.X(32), 0); _bStart.Click += delegate { _app.StartGateway(); };
            _bStop = new MgButton("停止", Mg.X(16), Mg.X(59), Mg.X(64), Mg.X(32), 1); _bStop.Click += delegate { _app.StopGateway(); };
            var bRestart = new MgButton("重启", Mg.X(16), Mg.X(102), Mg.X(64), Mg.X(32), 1); bRestart.Click += delegate { _app.RestartGateway(); };
            var bPanel = new MgButton("面板", Mg.X(16), Mg.X(145), Mg.X(64), Mg.X(32), 1); bPanel.Click += delegate { _app.OpenPanel(); };
            var bLogs = new MgButton("日志", Mg.X(16), Mg.X(188), Mg.X(64), Mg.X(32), 1); bLogs.Click += delegate { _app.OpenLogs(); };
            _btns = new List<MgButton>(new MgButton[] { bMin, bClose, _bStart, _bStop, bRestart, bPanel, bLogs });

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

            // 无边框拖动：空白区按住即可拖；按钮区域走虚拟按钮命中
            MouseDown += FormMouseDown; MouseMove += FormMouseMove; MouseUp += FormMouseUp; MouseLeave += FormMouseLeave;

            // 状态点呼吸重绘
            var pulse = new System.Windows.Forms.Timer { Interval = 300 };
            pulse.Tick += delegate { if (_alive && Visible) Invalidate(); };
            pulse.Start();
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            try
            {
                int pref = 2; // DWMWCP_ROUND：Win11 圆角
                Mg.DwmSetWindowAttribute(Handle, 33, ref pref, 4);
                int none = unchecked((int)0xFFFFFFFE); // DWMWA_COLOR_NONE
                Mg.DwmSetWindowAttribute(Handle, 34, ref none, 4);
            }
            catch { }
        }

        protected override void OnPaintBackground(PaintEventArgs e)
        {
            e.Graphics.Clear(Theme.Sink);   // 窗底：admin.html --sink 同源，随 Opacity 整体半透明
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAlias;
            DrawUi(g);
        }

        static readonly StringFormat Sf = (StringFormat)StringFormat.GenericTypographic.Clone();

        void DrawStr(Graphics g, string s, Font f, Color c, int x, int y)
        {
            using (var b = new SolidBrush(c)) g.DrawString(s, f, b, x, y, Sf);
        }

        int StrW(Graphics g, string s, Font f) { return (int)Math.Ceiling(g.MeasureString(s, f, int.MaxValue, Sf).Width); }

        // 模型名/上游名可能超宽：按可用宽度截断加 …
        string Truncate(Graphics g, string s, Font f, int maxW)
        {
            if (StrW(g, s, f) <= maxW) return s;
            while (s.Length > 1 && StrW(g, s + "…", f) > maxW) s = s.Substring(0, s.Length - 1);
            return s + "…";
        }

        // 信息卡：card2 半透明底 + edge 细边 + 圆角（admin.html 同款）
        void DrawCard(Graphics g, Rectangle r)
        {
            using (var p = Mg.RoundRect(r, Mg.X(12)))
            {
                using (var b = new SolidBrush(Color.FromArgb(160, Theme.Card2))) g.FillPath(b, p);
                using (var pen = new Pen(Theme.Edge)) g.DrawPath(pen, p);
            }
        }

        void DrawUi(Graphics g)
        {
            // 窗底由 OnPaintBackground 填 Theme.Sink；状态词下垫半透明胶囊

            // 运行中：右列最顶（y=16，与左列启动按钮同顶线）
            using (var p = Mg.RoundRect(new Rectangle(Mg.X(94), Mg.X(14), Mg.X(112), Mg.X(28)), Mg.X(9)))
            using (var b = new SolidBrush(Color.FromArgb(140, Theme.Card2)))
            {
                g.FillPath(b, p);
            }
            int dcx = Mg.X(106), dcy = Mg.X(28);
            if (_alive)
            {
                // 呼吸：外圈半透明光晕脉动 + 实心点
                int pr = ((Environment.TickCount / 300) % 2) == 0 ? Mg.X(3) : Mg.X(4);
                using (var b = new SolidBrush(Color.FromArgb(80, _stateDot)))
                {
                    g.FillEllipse(b, dcx - pr, dcy - pr, pr * 2, pr * 2);
                }
            }
            using (var b = new SolidBrush(_stateDot))
            {
                g.FillEllipse(b, dcx - Mg.X(3), dcy - Mg.X(3), Mg.X(6), Mg.X(6));
            }
            DrawStr(g, _stateText, _fState, Theme.Ink, Mg.X(118), Mg.X(19));

            bool hasStats = _alive && _statsOk;

            // 四卡：x=96 w=208 h=29，y=68/109/150/191（步长 41、卡距 12），词元卡底 220=日志按钮底——
            // 四卡占用原先三卡（y=68/128/188 h=32）的同一竖向空间，卡内文字 10pt→8.5pt；
            // 卡内左右排布——标签 x=110、数值 x=154，垂直 y=卡顶+6
            // 上游卡
            DrawCard(g, new Rectangle(Mg.X(96), Mg.X(68), Mg.X(208), Mg.X(29)));
            DrawStr(g, "上游", _fLab, Theme.Ink3, Mg.X(110), Mg.X(74));
            if (hasStats && !string.IsNullOrEmpty(_curUpstream))
            {
                DrawStr(g, Truncate(g, _curUpstream, _fVal, Mg.X(132)), _fVal, Theme.Accent, Mg.X(154), Mg.X(74));
            }
            else
            {
                DrawStr(g, "待命中", _fLab, Theme.Ink3, Mg.X(154), Mg.X(74));
            }

            // 模型卡
            DrawCard(g, new Rectangle(Mg.X(96), Mg.X(109), Mg.X(208), Mg.X(29)));
            DrawStr(g, "模型", _fLab, Theme.Ink3, Mg.X(110), Mg.X(115));
            if (hasStats && !string.IsNullOrEmpty(_curModel))
            {
                DrawStr(g, Truncate(g, _curModel, _fVal, Mg.X(132)), _fVal, Theme.Accent, Mg.X(154), Mg.X(115));
            }
            else
            {
                DrawStr(g, "未在服务", _fLab, Theme.Ink3, Mg.X(154), Mg.X(115));
            }

            // 词元卡（今日 token 消耗）
            DrawCard(g, new Rectangle(Mg.X(96), Mg.X(150), Mg.X(208), Mg.X(29)));
            DrawStr(g, "词元", _fLab, Theme.Ink3, Mg.X(110), Mg.X(156));
            string tokStr = hasStats ? FmtTok(_todayTokens) : "0";
            DrawStr(g, tokStr, _fVal, hasStats ? Theme.Accent : Theme.Ink3, Mg.X(154), Mg.X(156));

            // 价格卡（当前模型在 jiyuan 上游的生效价：入/出/缓存读 元/M；当前模型不在价表时退目录首模型）
            DrawCard(g, new Rectangle(Mg.X(96), Mg.X(191), Mg.X(208), Mg.X(29)));
            DrawStr(g, "价格", _fLab, Theme.Ink3, Mg.X(110), Mg.X(197));
            string priceStr; bool hasPrice = PriceValue(out priceStr);
            DrawStr(g, Truncate(g, priceStr, _fVal, Mg.X(118)), _fVal, hasPrice ? Theme.Accent : Theme.Ink3, Mg.X(154), Mg.X(197));

            foreach (var b in _btns) b.Paint(g);
            g.ResetClip();
        }

        // 价格卡取值：当前 serving 模型 → 目录首模型，命中价表即返回「入/出/缓存读 元/M」。
        // 价表未取到=「…」（拉取中/失败），模型未匹配=「—」（如 opencodego 系模型不在 jiyuan 价表）
        bool PriceValue(out string display)
        {
            var t = _app.PriceTable;
            if (t == null) { display = "…"; return false; }
            string m = (_curModel != null && t.ContainsKey(_curModel)) ? _curModel
                : (_dirModel != null && t.ContainsKey(_dirModel)) ? _dirModel : null;
            if (m == null) { display = "—"; return false; }
            string[] p = t[m];
            display = p[0] + "/" + p[1] + "/" + p[2] + " 元/M";
            return true;
        }

        // 重启点击后的即时视觉反馈：状态词切「重连中」，等首轮健康轮询接管
        public void ShowRestarting()
        {
            _stateText = "重连中";
            _stateDot = Theme.Warn;
            _alive = false;
            Invalidate();
        }

        public void ApplyStatus(StatusInfo st, string stateText, Color stateDot)
        {
            // 传输中：两次轮询间 requests / todayTokens 有变化即视为有流量（首轮不判）
            bool active = st.Alive && st.StatsOk && (_lastReq >= 0 || _lastTok >= 0)
                && (st.Requests != _lastReq || st.TodayTokens != _lastTok);
            _lastReq = st.Requests;
            _lastTok = st.TodayTokens;
            _stateText = st.Alive ? "运行中" : stateText;
            _stateDot = stateDot;
            if (active)
            {
                _stateText = "传输中";
                _stateDot = Theme.Accent;
            }
            _alive = st.Alive;
            _statsOk = st.StatsOk;
            _todayTokens = st.TodayTokens;
            _curModel = st.CurModel;
            _curUpstream = st.Upstream;
            _dirModel = st.DirModel;
            // primary 跟随状态：停止态主推「启动」，运行态主推「停止」
            _bStart.SetKind(st.Alive ? 1 : 0);
            _bStop.SetKind(st.Alive ? 0 : 1);
            Invalidate();
        }

        static string FmtTok(long n)
        {
            if (n >= 100000000) return Math.Round(n / 100000000.0, 1) + "亿";
            if (n >= 10000) return Math.Round(n / 10000.0, 1) + "万";
            return n.ToString();
        }

        MgButton HitBtn(int x, int y)
        {
            foreach (var b in _btns) if (b.Rect.Contains(x, y)) return b;
            return null;
        }

        void FormMouseDown(object sender, MouseEventArgs e)
        {
            var b = HitBtn(e.X, e.Y);
            if (b != null) { b.Down = true; Invalidate(); return; }
            // 原生标题栏拖动：系统接管整个按下-拖动-释放流程，杜绝拖动状态卡死
            if (e.Button == MouseButtons.Left)
            {
                Mg.ReleaseCapture();
                Mg.SendMessage(Handle, 0xA1 /*WM_NCLBUTTONDOWN*/, (IntPtr)2 /*HTCAPTION*/, IntPtr.Zero);
            }
        }

        void FormMouseMove(object sender, MouseEventArgs e)
        {
            bool dirty = false;
            foreach (var b in _btns)
            {
                bool hot = b.Rect.Contains(e.X, e.Y);
                if (b.Hot != hot) { b.Hot = hot; dirty = true; }
            }
            Cursor = HitBtn(e.X, e.Y) != null ? Cursors.Hand : Cursors.Default;
            if (dirty) Invalidate();
        }

        void FormMouseUp(object sender, MouseEventArgs e)
        {
            var b = HitBtn(e.X, e.Y);
            MgButton fired = null;
            foreach (var x in _btns)
            {
                if (x.Down) { x.Down = false; if (x == b) fired = x; }
            }
            Invalidate();
            if (fired != null && fired.Click != null) fired.Click(this, EventArgs.Empty);
        }

        void FormMouseLeave(object sender, EventArgs e)
        {
            bool dirty = false;
            foreach (var x in _btns)
            {
                if (x.Hot || x.Down) { x.Hot = false; x.Down = false; dirty = true; }
            }
            if (dirty) Invalidate();
        }

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
            Invalidate();
        }
    }
}
