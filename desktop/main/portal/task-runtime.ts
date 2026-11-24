import { access, cp, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { windowsEnvironment, windowsExecutable } from './windows';

const moveRuntimeDirectory = String.raw`
$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class PortalRuntimeDirectory {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
  private static extern bool MoveFileExW(string source, string destination, uint flags);

  public static int Rename(string source, string destination) {
    const uint ReplaceExisting = 1;
    return MoveFileExW(source, destination, ReplaceExisting) ? 0 : Marshal.GetLastWin32Error();
  }
}
'@
} catch { exit 2 }
$code = [PortalRuntimeDirectory]::Rename($env:PORTAL_RUNTIME_RENAME_SOURCE, $env:PORTAL_RUNTIME_RENAME_DESTINATION)
if ($code) {
  [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
  [Console]::WriteLine("Win32 error $($code): $([ComponentModel.Win32Exception]::new($code).Message)")
}
`;

/** Standalone engines may omit the sidecar; client packages always carry it. */
export async function portalRuntimeId(binary: string): Promise<string | undefined> {
  const text = await readFile(path.join(path.dirname(binary), 'portal-runtime/runtime.json'), 'utf8')
    .catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (text === undefined) return undefined;
  const value = JSON.parse(text);
  if (value.schema !== 1 || !/^[a-f0-9]{64}$/.test(value.id)) throw new Error('Portal 内置运行时清单无效。');
  return value.id;
}

async function runtimeManifestId(root: string) {
  const document = JSON.parse(await readFile(path.join(root, 'runtime.json'), 'utf8')) as {
    schema?: number; id?: string; python?: { path?: string }; node?: { path?: string };
  };
  if (document.schema !== 1 || !/^[a-f0-9]{64}$/.test(document.id || '') ||
      !document.python?.path || !document.node?.path ||
      !document.python.path.split(/[\\/]/).every(part => part && part !== '.' && part !== '..') ||
      !document.node.path.split(/[\\/]/).every(part => part && part !== '.' && part !== '..')) return undefined;
  await access(path.join(root, document.python.path));
  await access(path.join(root, document.node.path));
  return document.id;
}

/** Install one user-level runtime copy shared by foreground and background Portal. */
export async function ensurePortalRuntime(binary: string, directory: string, runtimeId?: string) {
  const id = runtimeId ?? await portalRuntimeId(binary);
  if (id === undefined) return undefined;
  const source = path.join(path.dirname(binary), 'portal-runtime');
  const sourceId = await runtimeManifestId(source);
  if (sourceId !== id) throw new Error('Portal 内置运行时清单与版本不一致。');
  const root = path.join(directory, 'portal-runtimes', id);
  if (await runtimeManifestId(root).catch(() => undefined) === id) return root;
  await mkdir(path.dirname(root), { recursive: true, mode: 0o700 });
  const temporary = `${root}.${randomUUID()}.tmp`;
  try {
    await cp(source, temporary, { recursive: true, verbatimSymlinks: true });
    await rm(root, { recursive: true, force: true });
    if (process.platform !== 'win32') await rename(temporary, root);
    else {
      // Use the same Win32 operation as libuv, preserving the error before it is translated.
      const { stdout } = await promisify(execFile)(windowsExecutable('powershell'), [
        '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(moveRuntimeDirectory, 'utf16le').toString('base64'),
      ], {
        windowsHide: true, timeout: 30_000, env: windowsEnvironment(process.env, {
          PORTAL_RUNTIME_RENAME_SOURCE: path.toNamespacedPath(temporary),
          PORTAL_RUNTIME_RENAME_DESTINATION: path.toNamespacedPath(root),
        }),
      }).catch(async (error: { code?: number | string }) => {
        // Fall back only when the helper did not reach the native rename.
        if (error.code !== 2 && error.code !== 'ENOENT' && error.code !== 'EACCES') throw error;
        await rename(temporary, root);
        return { stdout: '' };
      });
      const failure = stdout.trim();
      if (failure) {
        const prefix = /^Win32 error (?:5|1314):/.test(failure) ? 'EPERM: ' : '';
        throw new Error(prefix + 'Portal 运行时目录重命名失败 ' + JSON.stringify(temporary) + ' -> ' + JSON.stringify(root) + '\n' + failure);
      }
    }
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch((cleanup: Error) => {
      // A locked staging directory can also fail to delete. Keep the rename error in the log.
      throw new Error((error as Error).message + '\nPortal 临时目录清理失败：' + cleanup.message, { cause: error });
    });
    throw error;
  }
  return root;
}
