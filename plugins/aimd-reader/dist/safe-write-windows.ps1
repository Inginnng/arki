# This helper is intentionally self-contained. The TypeScript caller verifies the
# SHA-256 of these exact bytes before invoking it and never falls back to a normal
# check-then-open write.
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$MaximumInputCharacters = 3145728
$MaximumContentBytes = 2097152

function Write-ProtocolResponse {
    param(
        [Parameter(Mandatory = $true)]
        [System.Collections.IDictionary] $Body,
        [Parameter(Mandatory = $true)]
        [int] $ExitCode
    )

    try {
        $json = ConvertTo-Json -InputObject $Body -Compress -Depth 3
        [Console]::Out.Write($json)
        [Console]::Out.Flush()
    }
    catch {
        # Never copy exception messages, paths, or raw helper diagnostics across
        # the process boundary.
    }

    [Environment]::Exit($ExitCode)
}

function Write-Unavailable {
    Write-ProtocolResponse -Body ([ordered]@{
        version = 1
        status = "error"
        code = "SAFE_WRITE_UNAVAILABLE"
    }) -ExitCode 12
}

function Read-BoundedStandardInput {
    $builder = [System.Text.StringBuilder]::new()
    $buffer = [char[]]::new(4096)

    while ($true) {
        $read = [Console]::In.Read($buffer, 0, $buffer.Length)
        if ($read -eq 0) {
            break
        }

        if (($builder.Length + $read) -gt $MaximumInputCharacters) {
            Write-Unavailable
        }

        [void] $builder.Append($buffer, 0, $read)
    }

    return $builder.ToString()
}

function Test-ExactProperties {
    param(
        [Parameter(Mandatory = $true)]
        [psobject] $Object,
        [Parameter(Mandatory = $true)]
        [string[]] $Expected
    )

    $actual = @($Object.PSObject.Properties.Name | Sort-Object)
    $wanted = @($Expected | Sort-Object)
    if ($actual.Count -ne $wanted.Count) {
        return $false
    }

    for ($index = 0; $index -lt $actual.Count; $index++) {
        if ($actual[$index] -cne $wanted[$index]) {
            return $false
        }
    }

    return $true
}

$nativeSource = @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Aimd.Reader.SafeWrite
{
    public static class LockedSiblingWriter
    {
        private const uint FILE_READ_ATTRIBUTES = 0x00000080;
        private const uint SYNCHRONIZE = 0x00100000;
        private const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
        private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
        private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
        private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
        private const uint FILE_NAME_NORMALIZED = 0x0;
        private const uint VOLUME_NAME_DOS = 0x0;

        [StructLayout(LayoutKind.Sequential)]
        private struct BY_HANDLE_FILE_INFORMATION
        {
            public uint FileAttributes;
            public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
            public uint VolumeSerialNumber;
            public uint FileSizeHigh;
            public uint FileSizeLow;
            public uint NumberOfLinks;
            public uint FileIndexHigh;
            public uint FileIndexLow;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(
            string fileName,
            uint desiredAccess,
            FileShare shareMode,
            IntPtr securityAttributes,
            FileMode creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetFileInformationByHandle(
            SafeFileHandle file,
            out BY_HANDLE_FILE_INFORMATION information);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetFinalPathNameByHandleW(
            SafeFileHandle file,
            StringBuilder path,
            uint pathLength,
            uint flags);

        private sealed class UnsafePathException : Exception
        {
        }

        public static string Write(
            string canonicalRoot,
            string canonicalSourcePath,
            string sourceContentSha256,
            string targetBasename,
            byte[] content)
        {
            var heldHandles = new List<SafeFileHandle>();
            try
            {
                string root = NormalizeAbsolutePath(canonicalRoot);
                string source = NormalizeAbsolutePath(canonicalSourcePath);
                string sourceParent = Path.GetDirectoryName(source);
                if (String.IsNullOrEmpty(sourceParent) || !IsWithin(root, sourceParent))
                {
                    throw new UnsafePathException();
                }

                string sourceName = Path.GetFileName(source);
                string sourceExtension = Path.GetExtension(sourceName);
                if ((!String.Equals(sourceExtension, ".md", StringComparison.OrdinalIgnoreCase) &&
                     !String.Equals(sourceExtension, ".markdown", StringComparison.OrdinalIgnoreCase)) ||
                    sourceName.Length <= sourceExtension.Length)
                {
                    throw new UnsafePathException();
                }

                string expectedBasename = Path.GetFileNameWithoutExtension(sourceName) + ".explained.md";
                if (!String.Equals(targetBasename, expectedBasename, StringComparison.Ordinal) ||
                    !IsSafeTargetBasename(targetBasename))
                {
                    throw new UnsafePathException();
                }

                foreach (string directory in EnumerateChain(root, sourceParent))
                {
                    heldHandles.Add(OpenAndVerify(directory, true, true));
                }

                heldHandles.Add(OpenAndVerify(source, false, false));
                if (!SourceContentMatches(source, sourceContentSha256))
                {
                    throw new UnsafePathException();
                }

                string target = Path.Combine(sourceParent, targetBasename);
                // CreateNew is the no-overwrite authority. If the process is killed
                // after creation but before Flush completes, a newly created partial
                // target may remain and a retry will report OUTPUT_ALREADY_EXISTS.
                // Atomic-new-output is intentionally a separate future protocol.
                try
                {
                    using (var output = new FileStream(
                        target,
                        FileMode.CreateNew,
                        FileAccess.Write,
                        FileShare.None,
                        4096,
                        FileOptions.WriteThrough))
                    {
                        output.Write(content, 0, content.Length);
                        output.Flush(true);
                    }
                }
                catch (IOException exception)
                {
                    int nativeCode = exception.HResult & 0xffff;
                    if (nativeCode == 80 || nativeCode == 183)
                    {
                        return "OUTPUT_ALREADY_EXISTS";
                    }
                    return "SAFE_WRITE_UNAVAILABLE";
                }

                return "CREATED";
            }
            catch (UnsafePathException)
            {
                return "UNSAFE_OUTPUT_PATH_CHANGED";
            }
            catch (UnauthorizedAccessException)
            {
                return "SAFE_WRITE_UNAVAILABLE";
            }
            catch (IOException)
            {
                return "SAFE_WRITE_UNAVAILABLE";
            }
            catch
            {
                return "SAFE_WRITE_UNAVAILABLE";
            }
            finally
            {
                for (int index = heldHandles.Count - 1; index >= 0; index--)
                {
                    heldHandles[index].Dispose();
                }
            }
        }

        private static bool IsSafeTargetBasename(string value)
        {
            if (String.IsNullOrEmpty(value) || value.Length > 255 ||
                ContainsControlOrUnpairedSurrogate(value) ||
                !String.Equals(Path.GetFileName(value), value, StringComparison.Ordinal) ||
                value.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 ||
                value.EndsWith(".", StringComparison.Ordinal) ||
                value.EndsWith(" ", StringComparison.Ordinal))
            {
                return false;
            }

            string stem = value.Split('.')[0].ToUpperInvariant();
            if (stem == "CON" || stem == "PRN" || stem == "AUX" || stem == "NUL" ||
                stem == "CONIN$" || stem == "CONOUT$")
            {
                return false;
            }
            char suffix = stem.Length == 4 ? stem[3] : '\0';
            bool reservedPortNumber =
                (suffix >= '1' && suffix <= '9') ||
                suffix == '\u00B9' ||
                suffix == '\u00B2' ||
                suffix == '\u00B3';
            if (stem.Length == 4 &&
                (stem.StartsWith("COM", StringComparison.Ordinal) ||
                 stem.StartsWith("LPT", StringComparison.Ordinal)) &&
                reservedPortNumber)
            {
                return false;
            }
            return true;
        }

        private static bool ContainsControlOrUnpairedSurrogate(string value)
        {
            for (int index = 0; index < value.Length; index++)
            {
                char character = value[index];
                if (Char.IsControl(character))
                {
                    return true;
                }
                if (Char.IsHighSurrogate(character))
                {
                    if (index + 1 >= value.Length || !Char.IsLowSurrogate(value[index + 1]))
                    {
                        return true;
                    }
                    index++;
                }
                else if (Char.IsLowSurrogate(character))
                {
                    return true;
                }
            }
            return false;
        }

        private static SafeFileHandle OpenAndVerify(
            string expectedPath,
            bool expectDirectory,
            bool allowWriteSharing)
        {
            FileShare shareMode = allowWriteSharing
                ? FileShare.Read | FileShare.Write
                : FileShare.Read;
            SafeFileHandle handle = CreateFileW(
                expectedPath,
                FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                shareMode,
                IntPtr.Zero,
                FileMode.Open,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                IntPtr.Zero);

            if (handle.IsInvalid)
            {
                handle.Dispose();
                throw new UnsafePathException();
            }

            try
            {
                BY_HANDLE_FILE_INFORMATION information;
                if (!GetFileInformationByHandle(handle, out information))
                {
                    throw new UnsafePathException();
                }

                bool isDirectory = (information.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
                bool isReparsePoint = (information.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
                if (isReparsePoint || isDirectory != expectDirectory)
                {
                    throw new UnsafePathException();
                }

                string finalPath = GetFinalPath(handle);
                if (!String.Equals(
                    NormalizeAbsolutePath(finalPath),
                    NormalizeAbsolutePath(expectedPath),
                    StringComparison.Ordinal))
                {
                    throw new UnsafePathException();
                }

                return handle;
            }
            catch
            {
                handle.Dispose();
                throw;
            }
        }

        private static bool SourceContentMatches(string source, string expectedSha256)
        {
            if (String.IsNullOrEmpty(expectedSha256) || expectedSha256.Length != 64)
            {
                return false;
            }

            for (int index = 0; index < expectedSha256.Length; index++)
            {
                char value = expectedSha256[index];
                if (!((value >= '0' && value <= '9') || (value >= 'a' && value <= 'f')))
                {
                    return false;
                }
            }

            using (var input = new FileStream(
                source,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read,
                4096,
                FileOptions.SequentialScan))
            {
                if (input.Length > 2097152)
                {
                    return false;
                }
                using (SHA256 sha256 = SHA256.Create())
                {
                    byte[] digest = sha256.ComputeHash(input);
                    string actual = BitConverter.ToString(digest).Replace("-", "").ToLowerInvariant();
                    return String.Equals(actual, expectedSha256, StringComparison.Ordinal);
                }
            }
        }

        private static string GetFinalPath(SafeFileHandle handle)
        {
            var buffer = new StringBuilder(32768);
            uint length = GetFinalPathNameByHandleW(
                handle,
                buffer,
                (uint)buffer.Capacity,
                FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
            if (length == 0 || length >= buffer.Capacity)
            {
                throw new UnsafePathException();
            }

            string result = buffer.ToString();
            if (result.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase))
            {
                return @"\\" + result.Substring(8);
            }
            if (result.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase))
            {
                return result.Substring(4);
            }

            return result;
        }

        private static string NormalizeAbsolutePath(string path)
        {
            if (String.IsNullOrWhiteSpace(path) ||
                ContainsControlOrUnpairedSurrogate(path) ||
                !Path.IsPathRooted(path))
            {
                throw new UnsafePathException();
            }

            string full = Path.GetFullPath(path);
            string pathRoot = Path.GetPathRoot(full);
            if (String.IsNullOrEmpty(pathRoot))
            {
                throw new UnsafePathException();
            }

            while (full.Length > pathRoot.Length &&
                   (full.EndsWith("\\", StringComparison.Ordinal) ||
                    full.EndsWith("/", StringComparison.Ordinal)))
            {
                full = full.Substring(0, full.Length - 1);
            }

            return full;
        }

        private static bool IsWithin(string root, string candidate)
        {
            if (String.Equals(root, candidate, StringComparison.Ordinal))
            {
                return true;
            }

            string prefix = root.EndsWith("\\", StringComparison.Ordinal) ||
                            root.EndsWith("/", StringComparison.Ordinal)
                ? root
                : root + Path.DirectorySeparatorChar;
            return candidate.StartsWith(prefix, StringComparison.Ordinal);
        }

        private static IEnumerable<string> EnumerateChain(string root, string parent)
        {
            var reversed = new List<string>();
            string current = parent;
            while (true)
            {
                reversed.Add(current);
                if (String.Equals(current, root, StringComparison.Ordinal))
                {
                    break;
                }

                string next = Path.GetDirectoryName(current);
                if (String.IsNullOrEmpty(next) || String.Equals(next, current, StringComparison.Ordinal))
                {
                    throw new UnsafePathException();
                }
                current = NormalizeAbsolutePath(next);
            }

            reversed.Reverse();
            return reversed;
        }
    }
}
'@

try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        Write-Unavailable
    }

    # Windows PowerShell 5.1 otherwise decodes redirected stdin with the active
    # OEM/ANSI code page, corrupting canonical paths outside that code page.
    [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

    Add-Type -TypeDefinition $nativeSource -Language CSharp -ErrorAction Stop | Out-Null

    $rawInput = Read-BoundedStandardInput
    if ([string]::IsNullOrWhiteSpace($rawInput)) {
        Write-Unavailable
    }

    $request = ConvertFrom-Json -InputObject $rawInput -ErrorAction Stop
    if ($null -eq $request -or $request -is [System.Array]) {
        Write-Unavailable
    }

    if ($request.operation -ceq "probe") {
        if (!(Test-ExactProperties -Object $request -Expected @("version", "operation")) -or
            $request.version -ne 1) {
            Write-Unavailable
        }

        Write-ProtocolResponse -Body ([ordered]@{
            version = 1
            status = "capable"
            capability = "windows_locked_chain_create_new_v1"
        }) -ExitCode 0
    }

    if ($request.operation -cne "create" -or
        !(Test-ExactProperties -Object $request -Expected @(
            "version",
            "operation",
            "canonicalRoot",
            "canonicalSourcePath",
            "sourceContentSha256",
            "targetBasename",
            "contentBase64"
        )) -or
        $request.version -ne 1 -or
        $request.canonicalRoot -isnot [string] -or
        $request.canonicalSourcePath -isnot [string] -or
        $request.sourceContentSha256 -isnot [string] -or
        $request.sourceContentSha256 -cnotmatch '^[a-f0-9]{64}$' -or
        $request.targetBasename -isnot [string] -or
        $request.contentBase64 -isnot [string]) {
        Write-Unavailable
    }

    $content = [Convert]::FromBase64String($request.contentBase64)
    if ($content.Length -gt $MaximumContentBytes) {
        Write-Unavailable
    }

    $result = [Aimd.Reader.SafeWrite.LockedSiblingWriter]::Write(
        $request.canonicalRoot,
        $request.canonicalSourcePath,
        $request.sourceContentSha256,
        $request.targetBasename,
        $content
    )

    switch ($result) {
        "CREATED" {
            Write-ProtocolResponse -Body ([ordered]@{
                version = 1
                status = "created"
            }) -ExitCode 0
        }
        "OUTPUT_ALREADY_EXISTS" {
            Write-ProtocolResponse -Body ([ordered]@{
                version = 1
                status = "error"
                code = "OUTPUT_ALREADY_EXISTS"
            }) -ExitCode 10
        }
        "UNSAFE_OUTPUT_PATH_CHANGED" {
            Write-ProtocolResponse -Body ([ordered]@{
                version = 1
                status = "error"
                code = "UNSAFE_OUTPUT_PATH_CHANGED"
            }) -ExitCode 11
        }
        default {
            Write-Unavailable
        }
    }
}
catch {
    Write-Unavailable
}
