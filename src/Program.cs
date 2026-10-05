using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace TyranoPatcher
{
    // Launches a TyranoScript game (Electron or NW.js build) with Chromium's remote debugging port
    // enabled, then injects patch.js into every page of the game over the DevTools protocol.
    // Nothing in the game folder is modified. The launcher stays running (no window) until the game
    // closes so the patch is re-applied whenever the game reloads its page (e.g. "back to title").
    internal static class Program
    {
        private const string AppName = "TyranoPatcher";

        internal static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        private static readonly string LogPath = Path.Combine(Path.GetTempPath(), AppName + ".log");
        private static readonly object LogLock = new object();

        // Executables that live next to games but are never the game itself.
        private static readonly Regex NotAGame = new Regex(
            @"^(unins\d*|uninstall.*|setup.*|notification_helper|nwjc|nacl64|chromedriver|crashpad_handler|payload|.*crash.*|vc_?redist.*|dxsetup|dxwebsetup|tyranopatcher.*)\.exe$",
            RegexOptions.IgnoreCase);

        [STAThread]
        private static int Main(string[] args)
        {
            try { File.WriteAllText(LogPath, ""); } catch { }
            try
            {
                return Run(args).GetAwaiter().GetResult();
            }
            catch (Exception e)
            {
                Log("fatal: " + e);
                ShowError(e.Message);
                return 1;
            }
        }

        private static async Task<int> Run(string[] args)
        {
            string selfPath = Assembly.GetExecutingAssembly().Location;
            string selfDir = Path.GetDirectoryName(selfPath);
            var settings = Settings.Load(Path.Combine(selfDir, AppName + ".ini"));

            // A game exe may be given on the command line (or dropped onto the launcher); every
            // other argument is passed through to the game.
            string game = null;
            var passthrough = new List<string>();
            foreach (var a in args)
            {
                if (game == null && a.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) && File.Exists(a))
                    game = Path.GetFullPath(a);
                else
                    passthrough.Add(a);
            }
            if (game == null && !string.IsNullOrWhiteSpace(settings.Game))
            {
                game = Path.IsPathRooted(settings.Game) ? settings.Game : Path.Combine(selfDir, settings.Game);
                if (!File.Exists(game)) throw new Exception("The game set in " + AppName + ".ini was not found:\n" + game);
            }
            if (game == null) game = FindGame(selfDir, selfPath);
            if (game == null)
            {
                ShowError("No game executable was found next to " + Path.GetFileName(selfPath) + ".\n\n" +
                          "Put " + Path.GetFileName(selfPath) + " in the game's folder (next to the game's .exe) and run it, " +
                          "or drag the game's .exe onto it.");
                return 2;
            }
            Log("game: " + game);

            int port = FreePort();
            var gameArgs = new List<string>
            {
                "--remote-debugging-port=" + port,
                // document.getAnimations() for Chromium < 84 (Electron < 10), used to finish CSS animations.
                "--enable-blink-features=WebAnimationsAPI",
            };
            gameArgs.AddRange(passthrough);
            string argLine = string.Join(" ", gameArgs.Select(QuoteArg));
            if (!string.IsNullOrWhiteSpace(settings.ExtraArgs)) argLine += " " + settings.ExtraArgs.Trim();

            var psi = new ProcessStartInfo(game, argLine)
            {
                WorkingDirectory = Path.GetDirectoryName(game),
                UseShellExecute = false,
            };
            Log("starting: " + psi.FileName + " " + psi.Arguments);
            Process proc = Process.Start(psi);

            string script = BuildScript(settings);
            // One DevTools session per page target; a session whose connection dropped (the
            // target still being listed) is opened again so the patch keeps being applied.
            var sessions = new Dictionary<string, Task>();
            var started = Stopwatch.StartNew();
            bool everConnected = false;

            while (true)
            {
                List<Dictionary<string, object>> targets = GetTargets(port);
                if (targets != null)
                {
                    everConnected = true;
                    foreach (var t in targets)
                    {
                        string id = Str(t, "id");
                        string type = Str(t, "type");
                        string ws = Str(t, "webSocketDebuggerUrl");
                        string url = Str(t, "url") ?? "";
                        if (id == null || ws == null || type != "page" || url.StartsWith("devtools:")) continue;
                        if (url.EndsWith("_generated_background_page.html")) continue; // NW.js internals
                        if (sessions.TryGetValue(id, out var running) && !running.IsCompleted) continue;
                        Log((sessions.ContainsKey(id) ? "re-attaching to " : "attaching to ") + url);
                        sessions[id] = Task.Run(() => new CdpSession(ws, script).RunAsync());
                    }
                }
                else if (proc.HasExited)
                {
                    // Debug endpoint gone and our process is gone: the game has been closed.
                    if (!everConnected)
                    {
                        Log("game exited before the patcher could attach, exit code " + SafeExitCode(proc));
                        ShowError("The game closed before the patch could be applied.\n\n" +
                                  "If the game was already running, close it and start it again through " + AppName + ".");
                        return 3;
                    }
                    break;
                }

                if (!everConnected && started.Elapsed > TimeSpan.FromSeconds(90))
                {
                    ShowError("Could not connect to the game. It may not be a TyranoScript (Electron / NW.js) game.");
                    return 4;
                }
                await Task.Delay(sessions.Count == 0 ? 200 : 2000).ConfigureAwait(false);
            }
            Log("game closed");
            return 0;
        }

        private static string BuildScript(Settings s)
        {
            string patch;
            using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("patch.js"))
            using (var reader = new StreamReader(stream, Encoding.UTF8))
                patch = reader.ReadToEnd();

            var config = new Dictionary<string, object>
            {
                { "transitionSkip", s.TransitionSkip },
                { "fastSkip", s.FastSkip },
                { "skipSoundEffects", s.SkipSoundEffects },
                { "toast", s.Toast },
                { "rollback", s.Rollback },
                { "rollbackKeys", s.RollbackKeys },
                { "rollbackMouseBack", s.RollbackMouseBack },
                { "rollbackHistory", s.RollbackHistory },
            };
            return "window.__tyranoPatcherConfig = window.__tyranoPatcherConfig || " + Json.Serialize(config) + ";\n" + patch;
        }

        internal static string FindGame(string dir, string selfPath)
        {
            var candidates = Directory.GetFiles(dir, "*.exe")
                .Where(f => !string.Equals(Path.GetFullPath(f), Path.GetFullPath(selfPath), StringComparison.OrdinalIgnoreCase))
                .Where(f => !NotAGame.IsMatch(Path.GetFileName(f)))
                .ToList();
            if (candidates.Count == 0) return null;
            // Electron / NW.js runtimes are big; any helper exe is small.
            return candidates.OrderByDescending(f => new FileInfo(f).Length).First();
        }

        private static int FreePort()
        {
            var l = new TcpListener(IPAddress.Loopback, 0);
            l.Start();
            int port = ((IPEndPoint)l.LocalEndpoint).Port;
            l.Stop();
            return port;
        }

        private static List<Dictionary<string, object>> GetTargets(int port)
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/json/list");
                req.Proxy = null;
                req.Timeout = 2000;
                req.ReadWriteTimeout = 2000;
                using (var resp = req.GetResponse())
                using (var reader = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                {
                    var list = Json.DeserializeObject(reader.ReadToEnd()) as object[];
                    return list?.OfType<Dictionary<string, object>>().ToList() ?? new List<Dictionary<string, object>>();
                }
            }
            catch
            {
                return null;
            }
        }

        internal static string Str(Dictionary<string, object> d, string key)
        {
            return d != null && d.TryGetValue(key, out var v) ? v as string : null;
        }

        private static string QuoteArg(string a)
        {
            if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return a;
            return "\"" + a.Replace("\"", "\\\"") + "\"";
        }

        private static string SafeExitCode(Process p)
        {
            try { return p.ExitCode.ToString(); } catch { return "?"; }
        }

        internal static void Log(string msg)
        {
            lock (LogLock)
            {
                try { File.AppendAllText(LogPath, DateTime.Now.ToString("HH:mm:ss.fff") + " " + msg + Environment.NewLine); } catch { }
            }
        }

        private static void ShowError(string msg)
        {
            MessageBox.Show(msg, AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    internal sealed class Settings
    {
        public string Game;
        public string ExtraArgs;
        public bool TransitionSkip = true;
        public bool FastSkip = true;
        public bool SkipSoundEffects = true;
        public bool Toast = true;
        public bool Rollback = true;
        public string RollbackKeys = "Backspace, PageUp";
        public bool RollbackMouseBack = true;
        public int RollbackHistory = 300;

        // Optional TyranoPatcher.ini next to the launcher, "key = value" lines, ';' or '#' comments.
        public static Settings Load(string path)
        {
            var s = new Settings();
            if (!File.Exists(path)) return s;
            foreach (var raw in File.ReadAllLines(path))
            {
                string line = raw.Trim();
                if (line.Length == 0 || line[0] == ';' || line[0] == '#' || line[0] == '[') continue;
                int eq = line.IndexOf('=');
                if (eq < 0) continue;
                string key = line.Substring(0, eq).Trim().ToLowerInvariant();
                string val = line.Substring(eq + 1).Trim();
                switch (key)
                {
                    case "game": s.Game = val.Trim('"'); break;
                    case "args": s.ExtraArgs = val; break;
                    case "transition_skip": s.TransitionSkip = Bool(val, true); break;
                    case "fast_skip": s.FastSkip = Bool(val, true); break;
                    case "skip_sound_effects": s.SkipSoundEffects = Bool(val, true); break;
                    case "toast": s.Toast = Bool(val, true); break;
                    case "rollback": s.Rollback = Bool(val, true); break;
                    case "rollback_keys": s.RollbackKeys = val; break;
                    case "rollback_mouse_back": s.RollbackMouseBack = Bool(val, true); break;
                    case "rollback_history":
                        if (int.TryParse(val, out var n) && n > 0) s.RollbackHistory = n;
                        break;
                }
            }
            return s;
        }

        private static bool Bool(string v, bool def)
        {
            switch (v.ToLowerInvariant())
            {
                case "1": case "true": case "yes": case "on": return true;
                case "0": case "false": case "no": case "off": return false;
                default: return def;
            }
        }
    }

    // One DevTools protocol connection to a page target.
    internal sealed class CdpSession
    {
        private readonly string _url;
        private readonly string _script;
        private readonly ClientWebSocket _ws = new ClientWebSocket();
        private readonly SemaphoreSlim _sendLock = new SemaphoreSlim(1, 1);
        private readonly ConcurrentDictionary<int, TaskCompletionSource<Dictionary<string, object>>> _pending =
            new ConcurrentDictionary<int, TaskCompletionSource<Dictionary<string, object>>>();
        private int _nextId;

        public CdpSession(string url, string script)
        {
            _url = url;
            _script = script;
        }

        public async Task RunAsync()
        {
            try
            {
                _ws.Options.Proxy = null;
                await _ws.ConnectAsync(new Uri(_url), CancellationToken.None).ConfigureAwait(false);
                var receive = ReceiveLoop();

                // Receives executionContextCreated for the current document and every later one.
                await Send("Runtime.enable").ConfigureAwait(false);
                await Send("Page.enable").ConfigureAwait(false);
                // Also register the patch to run before page scripts on every future load.
                var r = await Send("Page.addScriptToEvaluateOnNewDocument", new Dictionary<string, object> { { "source", _script } }).ConfigureAwait(false);
                if (r == null || r.ContainsKey("error"))
                    await Send("Page.addScriptToEvaluateOnLoad", new Dictionary<string, object> { { "scriptSource", _script } }).ConfigureAwait(false);

                await receive.ConfigureAwait(false);
            }
            catch (Exception e)
            {
                Program.Log("session " + _url + " ended: " + e.Message);
            }
        }

        private async Task ReceiveLoop()
        {
            var buffer = new byte[64 * 1024];
            var message = new MemoryStream();
            while (_ws.State == WebSocketState.Open)
            {
                WebSocketReceiveResult res = await _ws.ReceiveAsync(new ArraySegment<byte>(buffer), CancellationToken.None).ConfigureAwait(false);
                if (res.MessageType == WebSocketMessageType.Close) break;
                message.Write(buffer, 0, res.Count);
                if (!res.EndOfMessage) continue;

                string text = Encoding.UTF8.GetString(message.GetBuffer(), 0, (int)message.Length);
                message.SetLength(0);
                Dictionary<string, object> msg;
                try { msg = Program.Json.DeserializeObject(text) as Dictionary<string, object>; }
                catch { continue; }
                if (msg == null) continue;

                if (msg.TryGetValue("id", out var idObj) && idObj is int id)
                {
                    if (_pending.TryRemove(id, out var tcs)) tcs.TrySetResult(msg);
                    continue;
                }
                if (Program.Str(msg, "method") == "Runtime.executionContextCreated")
                    OnContextCreated(msg);
            }
            foreach (var p in _pending.Values) p.TrySetResult(null);
        }

        private void OnContextCreated(Dictionary<string, object> msg)
        {
            var prm = msg.TryGetValue("params", out var p) ? p as Dictionary<string, object> : null;
            var ctx = prm != null && prm.TryGetValue("context", out var c) ? c as Dictionary<string, object> : null;
            if (ctx == null || !(ctx.TryGetValue("id", out var cid) && cid is int contextId)) return;

            // Only the page's main world; skip isolated worlds (preload scripts, extensions).
            if (ctx.TryGetValue("auxData", out var aux) && aux is Dictionary<string, object> auxData &&
                auxData.TryGetValue("isDefault", out var isDefault) && isDefault is bool b && !b) return;
            if (ctx.TryGetValue("isPageContext", out var isPage) && isPage is bool pb && !pb) return; // old Chromium
            string origin = Program.Str(ctx, "origin") ?? "";
            if (origin.StartsWith("devtools:")) return;

            Program.Log("injecting into context " + contextId + " " + origin);
            var _ = Send("Runtime.evaluate", new Dictionary<string, object>
            {
                { "expression", _script },
                { "contextId", contextId },
                { "silent", true },
            });
        }

        private async Task<Dictionary<string, object>> Send(string method, Dictionary<string, object> parameters = null)
        {
            int id = Interlocked.Increment(ref _nextId);
            var tcs = new TaskCompletionSource<Dictionary<string, object>>(TaskCreationOptions.RunContinuationsAsynchronously);
            _pending[id] = tcs;
            var payload = new Dictionary<string, object> { { "id", id }, { "method", method }, { "params", parameters ?? new Dictionary<string, object>() } };
            byte[] bytes = Encoding.UTF8.GetBytes(Program.Json.Serialize(payload));

            await _sendLock.WaitAsync().ConfigureAwait(false);
            try
            {
                await _ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None).ConfigureAwait(false);
            }
            catch
            {
                _pending.TryRemove(id, out _);
                return null;
            }
            finally
            {
                _sendLock.Release();
            }

            var done = await Task.WhenAny(tcs.Task, Task.Delay(10000)).ConfigureAwait(false);
            _pending.TryRemove(id, out _);
            return done == tcs.Task ? tcs.Task.Result : null;
        }
    }
}
