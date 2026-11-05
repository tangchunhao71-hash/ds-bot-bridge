# The Host parent starts this existing PowerShell 7 executable with anonymous
# stdin/stdout pipes and windowsHide. No TCP listener, service or stored secret.
param(
    [string]$PipeName,
    [string]$Mode = 'Server',
    [uint32]$ExpectedServerPid = 0,
    [string]$ExpectedServerImage,
    [int]$TimeoutMs = 45000
)

$ErrorActionPreference = 'Stop'
if (-not [OperatingSystem]::IsWindows()) {
    [Console]::Out.WriteLine('{"kind":"fatal","code":"windows_required"}')
    exit 1
}

$pipeBrokerSource = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

namespace DSDotBridge {
    public sealed class PipeNativeClient {
        private const int MaxFrameBytes = 1024 * 1024;
        private const uint GENERIC_READ = 0x80000000;
        private const uint GENERIC_WRITE = 0x40000000;
        private const uint FILE_FLAG_OVERLAPPED = 0x40000000;
        private const uint SECURITY_SQOS_PRESENT = 0x00100000;
        private const uint SECURITY_ANONYMOUS = 0x00000000;
        private readonly Stream input = Console.OpenStandardInput();
        private readonly Stream output = Console.OpenStandardOutput();
        private readonly JsonSerializerOptions jsonOptions = new JsonSerializerOptions {
            Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping, MaxDepth = 64
        };
        private long sentBytes;
        private bool requestWritten;
        private bool dispatchUnknown;
        private string phase = "CLIENT_START_FAILED";

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafePipeHandle CreateFileW(string name, uint access, uint sharing, IntPtr securityAttributes, uint creation, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint serverPid);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern SafeProcessHandle OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint processId);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool QueryFullProcessImageNameW(SafeProcessHandle process, uint flags, StringBuilder name, ref uint size);

        private void Emit(object value) {
            byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(value, jsonOptions);
            output.Write(bytes, 0, bytes.Length);
            output.WriteByte(10);
            output.Flush();
        }

        private int Fail(string code, int? nativeErrorCode = null) {
            try { Emit(new { kind = "fatal", code, nativeErrorCode, sentBytes, requestWritten, dispatchUnknown }); } catch { }
            return 1;
        }

        private static void VerifyServerImage(uint processId, string expectedImage) {
            using (SafeProcessHandle process = OpenProcess(0x1000, false, processId)) {
                if (process.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
                StringBuilder name = new StringBuilder(32768);
                uint length = (uint)name.Capacity;
                if (!QueryFullProcessImageNameW(process, 0, name, ref length)) throw new Win32Exception(Marshal.GetLastWin32Error());
                if (!String.Equals(Path.GetFullPath(name.ToString()).TrimEnd('\\'), Path.GetFullPath(expectedImage).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("SERVER_IMAGE_MISMATCH");
            }
        }

        private async Task<byte[]> ReadRequestAsync(CancellationToken token) {
            byte[] chunk = new byte[8192];
            using (MemoryStream line = new MemoryStream()) {
                while (true) {
                    int count = await input.ReadAsync(chunk.AsMemory(), token).ConfigureAwait(false);
                    if (count == 0) throw new EndOfStreamException();
                    for (int index = 0; index < count; index++) {
                        if (chunk[index] == 10) {
                            if (index != count - 1) throw new InvalidDataException();
                            byte[] bytes = line.ToArray();
                            new UTF8Encoding(false, true).GetCharCount(bytes);
                            using (JsonDocument document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 64 })) {
                                JsonElement root = document.RootElement;
                                if (root.ValueKind != JsonValueKind.Object || root.EnumerateObject().Count() != 1 ||
                                    !root.TryGetProperty("payload", out JsonElement payload)) throw new InvalidDataException();
                                byte[] body = JsonSerializer.SerializeToUtf8Bytes(payload, jsonOptions);
                                if (body.Length < 1 || body.Length > MaxFrameBytes) throw new InvalidDataException();
                                return body;
                            }
                        }
                        if (line.Length >= 8 * MaxFrameBytes) throw new InvalidDataException();
                        line.WriteByte(chunk[index]);
                    }
                }
            }
        }

        private async Task WatchParentAsync(CancellationTokenSource deadline) {
            try {
                byte[] unexpected = new byte[1];
                // EOF or any extra command is cancellation. There is no RPC or
                // second request on this client subprocess's anonymous stdin.
                await input.ReadAsync(unexpected.AsMemory(), deadline.Token).ConfigureAwait(false);
                deadline.Cancel();
            } catch (OperationCanceledException) { }
            catch { deadline.Cancel(); }
        }

        private static async Task ReadExactAsync(Stream stream, byte[] bytes, CancellationToken token) {
            int offset = 0;
            while (offset < bytes.Length) {
                int count = await stream.ReadAsync(bytes.AsMemory(offset), token).ConfigureAwait(false);
                if (count == 0) throw new EndOfStreamException();
                offset += count;
            }
        }

        private async Task<int> RunAsync(string pipeName, uint expectedServerPid, string expectedImage, int timeoutMs) {
            if (pipeName == null || !Regex.IsMatch(pipeName, @"\Ads-dot-bridge-[A-Za-z0-9_-]{1,106}\z", RegexOptions.CultureInvariant))
                return Fail("INVALID_PIPE_NAME");
            if (expectedServerPid == 0 || timeoutMs < 1 || timeoutMs > 45000 || String.IsNullOrWhiteSpace(expectedImage) ||
                !Regex.IsMatch(expectedImage, @"\A[A-Za-z]:[\\/]", RegexOptions.CultureInvariant)) return Fail("INVALID_CLIENT_OPTIONS");

            using (CancellationTokenSource deadline = new CancellationTokenSource(timeoutMs)) {
                phase = "PIPE_CONNECT_FAILED";
                // Same handle for verification and dispatch. Anonymous SQOS is
                // explicit even for a malicious or incorrectly named server.
                using (SafePipeHandle handle = CreateFileW(@"\\.\pipe\" + pipeName, GENERIC_READ | GENERIC_WRITE, 0,
                    IntPtr.Zero, 3, FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_ANONYMOUS, IntPtr.Zero)) {
                    if (handle.IsInvalid) return Fail(phase, Marshal.GetLastWin32Error());
                    phase = "SERVER_PID_UNAVAILABLE";
                    if (!GetNamedPipeServerProcessId(handle, out uint serverPid)) return Fail(phase, Marshal.GetLastWin32Error());
                    if (serverPid != expectedServerPid) return Fail("SERVER_PID_MISMATCH");
                    phase = "SERVER_IMAGE_UNAVAILABLE";
                    try { VerifyServerImage(serverPid, expectedImage); }
                    catch (InvalidOperationException) { return Fail("SERVER_IMAGE_MISMATCH"); }
                    Emit(new { kind = "verified", serverPid,
                        security = new { anonymous = true, serverPidVerified = true, serverImageVerified = true } });

                    phase = "INVALID_REQUEST_JSON";
                    byte[] body = await ReadRequestAsync(deadline.Token).ConfigureAwait(false);
                    _ = WatchParentAsync(deadline);
                    using (NamedPipeClientStream pipe = new NamedPipeClientStream(PipeDirection.InOut, true, true, handle))
                    using (deadline.Token.Register(() => { try { pipe.Dispose(); } catch { } })) {
                        byte[] header = BitConverter.GetBytes((uint)body.Length);
                        if (!BitConverter.IsLittleEndian) Array.Reverse(header);
                        phase = "PIPE_WRITE_FAILED";
                        dispatchUnknown = true;
                        Emit(new { kind = "dispatching", frameBytes = body.Length + 4 });
                        await pipe.WriteAsync(header.AsMemory(), deadline.Token).ConfigureAwait(false);
                        sentBytes = 4;
                        await pipe.WriteAsync(body.AsMemory(), deadline.Token).ConfigureAwait(false);
                        sentBytes += body.Length;
                        requestWritten = true;
                        await pipe.FlushAsync(deadline.Token).ConfigureAwait(false);
                        Emit(new { kind = "written", sentBytes });

                        phase = "INVALID_RESPONSE_FRAME";
                        await ReadExactAsync(pipe, header, deadline.Token).ConfigureAwait(false);
                        uint length = (uint)(header[0] | (header[1] << 8) | (header[2] << 16) | (header[3] << 24));
                        if (length < 1 || length > MaxFrameBytes) return Fail(phase);
                        byte[] responseBytes = new byte[length];
                        await ReadExactAsync(pipe, responseBytes, deadline.Token).ConfigureAwait(false);
                        phase = "INVALID_RESPONSE_JSON";
                        new UTF8Encoding(false, true).GetCharCount(responseBytes);
                        using (JsonDocument response = JsonDocument.Parse(responseBytes, new JsonDocumentOptions { MaxDepth = 64 })) {
                            phase = "INVALID_RESPONSE_FRAME";
                            // A single frame is followed by the broker's close.
                            // Wait for close before allowing the next call.
                            byte[] extra = new byte[1];
                            int extraCount;
                            try { extraCount = await pipe.ReadAsync(extra.AsMemory(), deadline.Token).ConfigureAwait(false); }
                            catch (IOException) { extraCount = 0; }
                            if (extraCount != 0) return Fail(phase);
                            Emit(new { kind = "result", payload = response.RootElement });
                            return 0;
                        }
                    }
                }
            }
        }

        public static int Run(string pipeName, uint expectedServerPid, string expectedImage, int timeoutMs) {
            PipeNativeClient client = new PipeNativeClient();
            try { return client.RunAsync(pipeName, expectedServerPid, expectedImage, timeoutMs).GetAwaiter().GetResult(); }
            catch (OperationCanceledException) { return client.Fail("PIPE_TIMEOUT"); }
            catch (Win32Exception error) { return client.Fail(client.phase, error.NativeErrorCode); }
            catch { return client.Fail(client.phase); }
        }
    }

    public sealed class PipeBroker {
        private const int MaxFrameBytes = 1024 * 1024;
        private const int MaxParentLineBytes = 8 * MaxFrameBytes;
        private const int RequestTimeoutMs = 45000;
        private const uint PIPE_ACCESS_DUPLEX = 0x00000003;
        private const uint FILE_FLAG_FIRST_PIPE_INSTANCE = 0x00080000;
        private const uint FILE_FLAG_OVERLAPPED = 0x40000000;
        private const uint PIPE_REJECT_REMOTE_CLIENTS = 0x00000008;
        private const uint HANDLE_FLAG_INHERIT = 0x00000001;
        private readonly CancellationTokenSource stop = new CancellationTokenSource();
        private readonly object gate = new object();
        private readonly Stream input = Console.OpenStandardInput();
        private readonly Stream output = Console.OpenStandardOutput();
        private readonly JsonSerializerOptions jsonOptions = new JsonSerializerOptions {
            Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
            MaxDepth = 64
        };
        private Pending pending;
        private int exitCode;
        private bool fatalReported;

        private sealed class Pending {
            public string Id;
            public readonly TaskCompletionSource<JsonElement> Reply = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct SECURITY_ATTRIBUTES {
            public int nLength;
            public IntPtr lpSecurityDescriptor;
            public int bInheritHandle;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct SID_AND_ATTRIBUTES {
            public IntPtr Sid;
            public uint Attributes;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct TOKEN_GROUPS {
            public uint GroupCount;
            public SID_AND_ATTRIBUTES FirstGroup;
        }

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetTokenInformation(SafeAccessTokenHandle token, int informationClass, IntPtr information, int informationLength, out int returnLength);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string descriptor, uint revision, out IntPtr securityDescriptor, out uint size);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr LocalFree(IntPtr memory);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateNamedPipeW(string name, uint openMode, uint pipeMode, uint maxInstances, uint outBufferSize, uint inBufferSize, uint defaultTimeout, ref SECURITY_ATTRIBUTES attributes);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetHandleInformation(SafePipeHandle handle, uint mask, uint flags);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetHandleInformation(SafePipeHandle handle, out uint flags);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CancelIoEx(SafePipeHandle handle, IntPtr overlapped);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool DisconnectNamedPipe(SafePipeHandle handle);

        private static void InterruptPipe(SafePipeHandle handle) {
            // A cancellation callback must not synchronously dispose a stream
            // whose overlapped operations/continuations are still unwinding.
            // CancelIoEx only requests cancellation; it does not wait for I/O.
            // Explicit disconnect also wakes a client with no own deadline.
            try { CancelIoEx(handle, IntPtr.Zero); } catch { }
            try { DisconnectNamedPipe(handle); } catch { }
        }

        private static SafePipeHandle CreatePipe(string pipeName) {
            // The logon SID scopes the ACL to one Windows logon session, not
            // all logons of the user's account. It is not a Dot-only identity.
            string logonSid;
            using (WindowsIdentity identity = WindowsIdentity.GetCurrent(TokenAccessLevels.Query)) {
                // WindowsIdentity.Groups intentionally excludes logon-ID
                // groups. Read TokenGroups and its SE_GROUP_LOGON_ID flags.
                GetTokenInformation(identity.AccessToken, 2, IntPtr.Zero, 0, out int needed);
                if (needed < Marshal.SizeOf<TOKEN_GROUPS>() || needed > MaxFrameBytes)
                    throw new InvalidOperationException("logon_sid_unavailable");
                IntPtr information = Marshal.AllocHGlobal(needed);
                try {
                    if (!GetTokenInformation(identity.AccessToken, 2, information, needed, out _))
                        throw new Win32Exception(Marshal.GetLastWin32Error());
                    uint count = (uint)Marshal.ReadInt32(information);
                    int offset = Marshal.OffsetOf<TOKEN_GROUPS>(nameof(TOKEN_GROUPS.FirstGroup)).ToInt32();
                    int stride = Marshal.SizeOf<SID_AND_ATTRIBUTES>();
                    if (count > (needed - offset) / stride) throw new InvalidOperationException("logon_sid_unavailable");
                    List<string> logonSids = new List<string>();
                    for (int index = 0; index < count; index++) {
                        SID_AND_ATTRIBUTES group = Marshal.PtrToStructure<SID_AND_ATTRIBUTES>(IntPtr.Add(information, offset + index * stride));
                        if ((group.Attributes & 0xC0000000u) == 0xC0000000u)
                            logonSids.Add(new SecurityIdentifier(group.Sid).Value);
                    }
                    if (logonSids.Count != 1 || !Regex.IsMatch(logonSids[0], @"\AS-1-5-5-\d+-\d+\z", RegexOptions.CultureInvariant))
                        throw new InvalidOperationException("logon_sid_unavailable");
                    logonSid = logonSids[0];
                } finally { Marshal.FreeHGlobal(information); }
            }
            // Protected DACL; one allow ACE, only the current logon SID.
            // Node/libuv opens GENERIC_READ|GENERIC_WRITE. Such same-logon
            // clients also have FILE_CREATE_PIPE_INSTANCE; FIRST_INSTANCE
            // and maxInstances=1 protect this broker's existing namespace.
            string sddl = "D:P(A;;GRGW;;;" + logonSid + ")";
            IntPtr descriptor = IntPtr.Zero;
            try {
                if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out descriptor, out _))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                SECURITY_ATTRIBUTES attributes = new SECURITY_ATTRIBUTES {
                    nLength = Marshal.SizeOf<SECURITY_ATTRIBUTES>(),
                    lpSecurityDescriptor = descriptor,
                    bInheritHandle = 0
                };
                IntPtr raw = CreateNamedPipeW(@"\\.\pipe\" + pipeName,
                    PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
                    PIPE_REJECT_REMOTE_CLIENTS, 1, 65536, 65536, 0, ref attributes);
                if (raw == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
                SafePipeHandle handle = new SafePipeHandle(raw, true);
                if (!SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) ||
                    !GetHandleInformation(handle, out uint flags) || (flags & HANDLE_FLAG_INHERIT) != 0) {
                    int error = Marshal.GetLastWin32Error();
                    handle.Dispose();
                    throw new Win32Exception(error);
                }
                return handle;
            } finally {
                if (descriptor != IntPtr.Zero) LocalFree(descriptor);
            }
        }

        private void Emit(object value) {
            byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(value, jsonOptions);
            lock (output) {
                output.Write(bytes, 0, bytes.Length);
                output.WriteByte(10);
                output.Flush();
            }
        }

        private void Fatal(string code, int? nativeErrorCode = null) {
            lock (gate) {
                if (stop.IsCancellationRequested || fatalReported) return;
                fatalReported = true;
                exitCode = 1;
            }
            // Neither stdout nor cancellation may run while holding gate.
            // Never include an exception message, request, response or SID.
            try { Emit(new { kind = "fatal", code, nativeErrorCode }); } catch { }
            Stop();
        }

        private void Stop() {
            Pending current;
            lock (gate) { current = pending; }
            // Cancel() runs callbacks synchronously. Keep those callbacks and
            // any inlined continuation outside the pending-reply lock.
            if (!stop.IsCancellationRequested) stop.Cancel();
            if (current != null) current.Reply.TrySetCanceled(stop.Token);
        }

        private async Task ReadParentAsync() {
            byte[] chunk = new byte[8192];
            using (MemoryStream line = new MemoryStream()) {
                try {
                    while (!stop.IsCancellationRequested) {
                        int count = await input.ReadAsync(chunk.AsMemory(), stop.Token).ConfigureAwait(false);
                        if (count == 0) { Stop(); return; }
                        for (int index = 0; index < count; index++) {
                            byte item = chunk[index];
                            if (item != 10) {
                                if (line.Length >= MaxParentLineBytes) { Fatal("parent_frame_too_large"); return; }
                                line.WriteByte(item);
                                continue;
                            }
                            byte[] bytes = line.ToArray();
                            line.SetLength(0);
                            if (bytes.Length > 0 && bytes[bytes.Length - 1] == 13) Array.Resize(ref bytes, bytes.Length - 1);
                            if (!AcceptParentLine(bytes)) return;
                        }
                    }
                } catch (OperationCanceledException) { }
                catch { Fatal("parent_io_failed"); }
            }
        }

        private bool AcceptParentLine(byte[] bytes) {
            try {
                new UTF8Encoding(false, true).GetCharCount(bytes);
                using (JsonDocument document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 64 })) {
                    JsonElement root = document.RootElement;
                    if (root.ValueKind != JsonValueKind.Object) { Fatal("parent_protocol_invalid"); return false; }
                    JsonProperty[] properties = root.EnumerateObject().ToArray();
                    if (properties.Length == 1 && properties[0].Name == "kind" &&
                        properties[0].Value.ValueKind == JsonValueKind.String && properties[0].Value.GetString() == "dispose") {
                        Stop(); return false;
                    }
                    if (properties.Length != 2 || !root.TryGetProperty("id", out JsonElement id) ||
                        id.ValueKind != JsonValueKind.String || !root.TryGetProperty("payload", out JsonElement payload) ||
                        properties.Select(property => property.Name).Distinct().Count() != 2) {
                        Fatal("parent_protocol_invalid"); return false;
                    }
                    lock (gate) {
                        if (pending == null || pending.Id != id.GetString() || !pending.Reply.TrySetResult(payload.Clone())) {
                            Fatal("parent_response_unmatched"); return false;
                        }
                    }
                    return true;
                }
            } catch { Fatal("parent_protocol_invalid"); return false; }
        }

        private static async Task ReadExactAsync(Stream stream, byte[] buffer, CancellationToken token) {
            int count = 0;
            while (count < buffer.Length) {
                int read = await stream.ReadAsync(buffer.AsMemory(count), token).ConfigureAwait(false);
                if (read == 0) throw new EndOfStreamException();
                count += read;
            }
        }

        private async Task HandleClientAsync(NamedPipeServerStream pipe) {
            using (CancellationTokenSource deadline = CancellationTokenSource.CreateLinkedTokenSource(stop.Token)) {
                deadline.CancelAfter(RequestTimeoutMs);
                byte[] header = new byte[4];
                await ReadExactAsync(pipe, header, deadline.Token).ConfigureAwait(false);
                uint length = (uint)(header[0] | (header[1] << 8) | (header[2] << 16) | (header[3] << 24));
                if (length == 0 || length > MaxFrameBytes) throw new InvalidDataException();
                byte[] bytes = new byte[length];
                await ReadExactAsync(pipe, bytes, deadline.Token).ConfigureAwait(false);
                new UTF8Encoding(false, true).GetCharCount(bytes);
                using (JsonDocument request = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 64 })) {
                    Pending current = new Pending { Id = Guid.NewGuid().ToString("N") };
                    lock (gate) {
                        if (stop.IsCancellationRequested) return;
                        pending = current;
                    }
                    try {
                        await Task.Run(() => Emit(new { kind = "request", id = current.Id, payload = request.RootElement }))
                            .WaitAsync(deadline.Token).ConfigureAwait(false);
                        // Waiting and writing share the original per-client 45s
                        // budget. Timeout closes this connection without replay.
                        JsonElement response = await current.Reply.Task.WaitAsync(deadline.Token).ConfigureAwait(false);
                        byte[] body = JsonSerializer.SerializeToUtf8Bytes(response, jsonOptions);
                        if (body.Length == 0 || body.Length > MaxFrameBytes) throw new InvalidDataException();
                        byte[] responseHeader = BitConverter.GetBytes((uint)body.Length);
                        if (!BitConverter.IsLittleEndian) Array.Reverse(responseHeader);
                        await pipe.WriteAsync(responseHeader.AsMemory(), deadline.Token).ConfigureAwait(false);
                        await pipe.WriteAsync(body.AsMemory(), deadline.Token).ConfigureAwait(false);
                        await pipe.FlushAsync(deadline.Token).ConfigureAwait(false);
                        // DisconnectNamedPipe discards unread bytes. Drain the
                        // one response before disconnect so small/fast replies
                        // cannot disappear before the client starts its read.
                        await Task.Run(() => pipe.WaitForPipeDrain()).WaitAsync(deadline.Token).ConfigureAwait(false);
                    } finally {
                        lock (gate) { if (ReferenceEquals(pending, current)) pending = null; }
                    }
                }
            }
        }

        private async Task<int> RunAsync(string pipeName) {
            if (pipeName == null || !Regex.IsMatch(pipeName, @"\Ads-dot-bridge-[A-Za-z0-9_-]{1,106}\z", RegexOptions.CultureInvariant)) {
                Fatal("invalid_pipe_name"); return exitCode;
            }
            SafePipeHandle handle;
            try { handle = CreatePipe(pipeName); }
            catch (Win32Exception error) { Fatal("pipe_create_failed", error.NativeErrorCode); return exitCode; }
            catch { Fatal("pipe_security_unavailable"); return exitCode; }

            using (handle)
            using (NamedPipeServerStream pipe = new NamedPipeServerStream(PipeDirection.InOut, true, false, handle))
            using (stop.Token.Register(() => InterruptPipe(handle))) {
                Emit(new { kind = "ready", pipeName, maxFrameBytes = MaxFrameBytes,
                    security = new { logonOnly = true, remoteRejected = true, firstInstance = true, protectedDacl = true, inheritable = false } });
                Task parent = ReadParentAsync();
                try {
                    while (!stop.IsCancellationRequested) {
                        await pipe.WaitForConnectionAsync(stop.Token).ConfigureAwait(false);
                        try { await HandleClientAsync(pipe).ConfigureAwait(false); }
                        catch (Exception error) when (error is IOException || error is InvalidDataException || error is JsonException || error is DecoderFallbackException || error is OperationCanceledException || error is ObjectDisposedException) {
                            // A bad, partial or timed-out client gets no dispatch
                            // retry and no payload-bearing diagnostic output.
                        }
                        finally {
                            if (!stop.IsCancellationRequested && pipe.IsConnected) pipe.Disconnect();
                        }
                    }
                } catch (OperationCanceledException) { }
                catch (ObjectDisposedException) when (stop.IsCancellationRequested) { }
                catch { Fatal("pipe_broker_failed"); }
                finally { Stop(); }
                // A reader blocked in anonymous stdin must not delay disposal.
                // Thread-pool reader work ends with this owned helper process.
                _ = parent;
            }
            return exitCode;
        }

        public static int Run(string pipeName) {
            PipeBroker broker = new PipeBroker();
            try { return broker.RunAsync(pipeName).GetAwaiter().GetResult(); }
            catch { broker.Fatal("pipe_broker_failed"); return 1; }
            finally { broker.Stop(); }
        }
    }
}
'@

try {
    Add-Type -TypeDefinition $pipeBrokerSource -Language CSharp -ErrorAction Stop
} catch {
    [Console]::Out.WriteLine('{"kind":"fatal","code":"helper_compile_failed"}')
    exit 1
}
if ($Mode -eq 'Client') {
    exit [DSDotBridge.PipeNativeClient]::Run($PipeName, $ExpectedServerPid, $ExpectedServerImage, $TimeoutMs)
}
if ($Mode -ne 'Server') {
    [Console]::Out.WriteLine('{"kind":"fatal","code":"invalid_mode"}')
    exit 1
}
exit [DSDotBridge.PipeBroker]::Run($PipeName)
