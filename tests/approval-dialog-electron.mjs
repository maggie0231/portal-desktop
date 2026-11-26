// Packaged Electron, a disposable profile, and a local approval requester.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { desktopExecutable, waitForChatReady } from './support/desktop.mjs';
import { launchDesktop } from './support/electron-lifecycle.mjs';

const executablePath = await desktopExecutable();
const temporary = await mkdtemp(path.join(os.tmpdir(), 'portal-approval-e2e-'));
const profile = path.join(temporary, 'profile');
let app;
let engine;
let sockets;
let chatSends = 0;
let chatAvailable = false;
const server = createServer((request, response) => {
  const { pathname } = new URL(request.url, 'http://localhost');
  if (pathname.endsWith('/api/status') && !chatAvailable) { response.writeHead(503); response.end(); return; }
  if (pathname.endsWith('/api/chat/stream') && request.method === 'POST') {
    request.once('end', () => {
      chatSends++;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('event: content_block_delta\ndata: {"delta":{"text":"审批测试"}}\n\nevent: message_stop\ndata: {}\n\n');
    });
    request.resume();
    return;
  }
  if (pathname.endsWith('/api/stream/active')) { response.writeHead(204); response.end(); return; }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ being_name: 'approval-fixture', messages: [] }));
});
async function waitFor(predicate, message) {
  const deadline = Date.now() + 10000;
  do {
    if (await predicate()) return;
    await delay(50);
  } while (Date.now() < deadline);
  assert.fail(message);
}

try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const launch = () => launchDesktop({ executablePath, env: { ...process.env, PORTAL_DESKTOP_USER_DATA: profile } });
  const endpoint = 'http://127.0.0.1:' + server.address().port + '/approval-fixture';
  app = await launch();
  await (await app.firstWindow()).getByRole('button', { name: '连接我的 Being' }).waitFor();
  const credential = await app.evaluate(({ safeStorage }, link) => {
    return safeStorage.encryptString(JSON.stringify({ link })).toString('base64');
  }, endpoint + '/?token=approval-test-token');
  await app.close();
  app = undefined;
  await writeFile(path.join(profile, 'connection.json'), JSON.stringify({
    version: 1, credential, settings: {
      workspace: temporary, portalName: 'approval-fixture', autoStart: false, backgroundEnabled: false,
      allowExec: false, kitsEnabled: false, permissionMode: 'supervised',
    },
  }));
  // A saved connection remains usable by the shell when the startup check
  // fails. Exercise the real approval IPC without starting a Rust engine.
  app = await launch();
  const page = await app.firstWindow();
  await waitFor(async () => {
    const log = await readFile(path.join(profile, 'logs/client-errors.log'), 'utf8').catch(() => '');
    return log.includes('[startup-connection]');
  }, 'The Portal startup check did not finish');
  chatAvailable = true;
  await page.reload();
  await waitForChatReady(page);

  const { port, token } = JSON.parse(await readFile(path.join(profile, '.portal-client.json'), 'utf8'));
  const requestApproval = async (livePermissionMode = false) => {
    const response = await fetch('http://127.0.0.1:' + port + '/command', {
      method: 'POST', headers: { authorization: 'Bearer ' + token },
      body: JSON.stringify({ endpoint, verb: 'security-approve', args: JSON.stringify({
        tool: 'portal_file_write', workspace: temporary, livePermissionMode, arguments: { path: 'approval-test-payload' },
      }) }),
      signal: AbortSignal.timeout(20000),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const dialog = page.getByRole('dialog', { name: '此操作需要你的允许' });
  const allow = dialog.getByRole('button', { name: '允许这一次', exact: true });
  const deny = dialog.getByRole('button', { name: '拒绝', exact: true });
  const settingsButton = dialog.getByRole('button', { name: '调整权限…', exact: true });
  const close = dialog.getByRole('button', { name: '关闭', exact: true });
  const permissionMenu = page.getByRole('menu', { name: '电脑操作权限' });
  const input = page.frameLocator('#chat-frame').locator('#input');
  const pendingId = () => page.evaluate(async () => (await window.beings.toolApprovalPending())?.id);
  const focusByTab = async (control, key = 'Tab') => {
    for (let step = 0; step < 8; step++) {
      await page.keyboard.press(key);
      if (await control.evaluate(button => button === document.activeElement)) return;
    }
    assert.fail('Tab did not reach approval button');
  };
  const respond = async (text, act) => {
    const response = requestApproval();
    await allow.waitFor();
    const id = await pendingId();
    assert(id);
    const focus = await allow.evaluate(button => ({
      action: document.activeElement?.getAttribute('data-approval-action') ?? document.activeElement?.tagName,
      outline: getComputedStyle(button).outlineStyle,
    }));
    assert.deepEqual(focus, { action: 'allow', outline: 'solid' });
    await act();
    assert.deepEqual(await response, { text });
    await dialog.waitFor({ state: 'hidden' });
    return id;
  };

  await page.evaluate(() => {
    window.approvalFocus = [];
    document.addEventListener('focusin', event => {
      if (event.target.closest('dialog[open]')?.querySelector('[data-approval-action="allow"]')) {
        window.approvalFocus.push(event.target.dataset.approvalAction ?? 'other');
      }
    });
  });
  await respond('allow-once', () => page.keyboard.press('Enter'));
  assert.equal(await page.evaluate(() => window.approvalFocus[0]), 'allow');
  await respond('deny', async () => {
    await focusByTab(deny);
    await page.keyboard.press('Enter');
  });
  await respond('allow-once', async () => {
    await focusByTab(deny, 'Shift+Tab');
    await focusByTab(allow);
    await page.keyboard.press('Enter');
  });
  await respond('allow-once', () => allow.click());
  await respond('deny', () => deny.click());
  await respond('deny', () => page.keyboard.press('Escape'));
  await respond('deny', () => close.click());
  await respond('allow-once', async () => {
    const id = await pendingId();
    await focusByTab(settingsButton, 'Shift+Tab');
    await page.keyboard.press('Enter');
    await permissionMenu.waitFor();
    await page.keyboard.press('Escape');
    await permissionMenu.waitFor({ state: 'hidden' });
    assert.equal(await pendingId(), id);
    await allow.click();
  });
  await respond('deny', async () => {
    const id = await pendingId();
    await settingsButton.click();
    await permissionMenu.getByRole('menuitemradio', { name: /每次询问/ }).click();
    await permissionMenu.waitFor({ state: 'hidden' });
    assert.equal(await pendingId(), id);
    await deny.click();
  });

  await input.fill('发送消息后保持 Enter 按下');
  await page.keyboard.down('Enter');
  await waitFor(() => chatSends === 1, 'The initial Enter did not send the chat message');
  const repeatId = await respond('allow-once', async () => {
    await page.keyboard.down('Enter');
    await page.keyboard.down('Enter');
    assert(await dialog.isVisible(), 'Auto-repeat settled the approval');
    assert.equal(chatSends, 1);
    await page.keyboard.up('Enter');
    assert(await dialog.isVisible(), 'Releasing the send key settled the approval');
    await page.keyboard.press('Enter');
  });

  const queuedRepeatIds = [];
  for (const key of ['Enter', 'Escape', 'Space']) {
    const firstQueued = requestApproval();
    await allow.waitFor();
    const firstQueuedId = await pendingId();
    assert(firstQueuedId);
    const secondQueued = requestApproval();
    const secondOpened = page.waitForEvent('console', message => {
      const text = message.text();
      return text.startsWith('[approval-ui] {"event":"opened"') && !text.includes(firstQueuedId);
    });
    await page.keyboard.down(key);
    // Space activates on release. Dismiss the first request while it is still held.
    if (key === 'Space') await page.keyboard.press('Escape');
    assert.deepEqual(await firstQueued, { text: key === 'Enter' ? 'allow-once' : 'deny' });
    await secondOpened;
    const secondId = await pendingId();
    assert(secondId && secondId !== firstQueuedId);
    await page.keyboard.down(key);
    await page.keyboard.up(key);
    assert.equal(await pendingId(), secondId, `Holding or releasing ${key} answered the next approval`);
    assert(await dialog.isVisible());
    await page.keyboard.press(key);
    assert.deepEqual(await secondQueued, { text: key === 'Escape' ? 'deny' : 'allow-once' });
    await dialog.waitFor({ state: 'hidden' });
    queuedRepeatIds.push(secondId);
  }

  const logFile = path.join(profile, 'logs', 'client-runtime.log');
  let nativeCloseId;
  for (const action of ['settings', 'window-close-queued', 'window-close-then-request']) {
    const first = requestApproval();
    await allow.waitFor();
    const firstDialog = await dialog.elementHandle();
    const firstId = await pendingId();
    assert(firstId);
    let next;
    if (action !== 'window-close-then-request') {
      next = requestApproval();
      await waitFor(async () => (await readFile(logFile, 'utf8')).includes(`"event":"queued","behindId":"${firstId}"`),
        'The second request did not enter the approval queue');
    }
    if (action === 'settings') {
      await focusByTab(settingsButton, 'Shift+Tab');
      await page.keyboard.down('Enter');
      await permissionMenu.waitFor();
      assert(await permissionMenu.evaluate(menu => menu.contains(document.activeElement)));
      await page.keyboard.down('Enter');
      await page.keyboard.up('Enter');
      await page.keyboard.press('ArrowDown');
      assert(await permissionMenu.evaluate(menu => menu.contains(document.activeElement)));
      assert.equal(await pendingId(), firstId);
      await page.keyboard.press('Escape');
      await permissionMenu.waitFor({ state: 'hidden' });
      assert.equal(await pendingId(), firstId);
      await deny.click();
    } else {
      nativeCloseId = firstId;
      await app.evaluate(({ BrowserWindow }) => new Promise(resolve => {
        const window = BrowserWindow.getAllWindows()[0];
        window.once('hide', () => resolve(true));
        window.close();
      }));
    }
    assert.deepEqual(await first, { text: 'deny' });
    if (!next) {
      assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
      next = requestApproval();
    }
    await waitFor(async () => {
      const id = await pendingId();
      return id && id !== firstId;
    }, 'The queued approval did not become pending');
    const nextId = await pendingId();
    if (action !== 'settings') {
      assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true,
        'The next approval must show the main window again');
    }
    await page.waitForFunction(previous => !previous.isConnected, firstDialog);
    await allow.waitFor();
    assert.equal(await pendingId(), nextId);
    assert(await allow.evaluate(button => document.activeElement === button));
    await page.keyboard.press('Escape');
    assert.deepEqual(await next, { text: 'deny' });
    await dialog.waitFor({ state: 'hidden' });
  }

  const reloaded = requestApproval();
  await allow.waitFor();
  const recoveredId = await pendingId();
  assert(recoveredId);
  await page.reload();
  await allow.waitFor();
  assert.equal(await pendingId(), recoveredId);
  await page.keyboard.press('Escape');
  assert.deepEqual(await reloaded, { text: 'deny' });

  // Connect the bundled engine to the same disposable Desktop. Observe both
  // sides of the policy change through real file writes and the original dialog.
  sockets = new WebSocketServer({ server, path: '/_relay' });
  let relay;
  const replies = new Map();
  sockets.on('connection', socket => socket.on('message', bytes => {
    const message = JSON.parse(bytes);
    if (message.loom_token) {
      assert.equal(message.loom_token, 'approval-test-token');
      relay = socket;
      socket.send(JSON.stringify({ ok: true, relay_keepalive: 'text-v1' }));
    } else if (message.type === 'keepalive') {
      socket.send(JSON.stringify({ type: 'keepalive_ack' }));
    } else if (message.id) replies.set(message.id, message);
  }));
  const config = path.join(temporary, 'test-portal.toml');
  await writeFile(config, `name = "approval-fixture"\nworkspace = ${JSON.stringify(temporary)}\nkits_enabled = false\n[subagent]\nenabled = false\n`);
  const resources = path.resolve(path.dirname(executablePath), process.platform === 'darwin' ? '../Resources' : 'resources');
  const binary = path.join(resources, process.platform === 'win32' ? 'heart-portal.exe' : 'heart-portal');
  engine = spawn(binary, ['--config', config, '--connect', endpoint + '/?token=approval-test-token', '--permission-mode', 'supervised'], {
    windowsHide: true, cwd: temporary, stdio: 'ignore', env: { ...process.env, HOME: temporary, USERPROFILE: temporary,
      HEART_PORTAL_CLIENT_MANAGED: '1', HEART_PORTAL_SUPERVISED: '1', HEART_PORTAL_CLIENT_FILE: path.join(profile, '.portal-client.json') },
  });
  await waitFor(() => relay, 'Packaged Rust engine did not connect');
  let sequence = 0;
  function requestWrite(filename, target = filename + '.txt') {
    const id = ++sequence;
    relay.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call',
      params: { name: 'portal_file_write', arguments: { path: target, content: filename } } }));
    return id;
  }
  async function chooseMode(label) {
    await settingsButton.click();
    await permissionMenu.getByRole('menuitemradio', { name: label }).click();
    await permissionMenu.waitFor({ state: 'hidden' });
  }
  // Check the managed profile boundary through a normal, explicitly approved
  // write. The fixture configuration must survive and subsequent saves work.
  const savedFile = path.join(profile, 'connection.json');
  const originalSettings = await readFile(savedFile, 'utf8');
  for (const target of [savedFile, path.join(profile, 'connection.json.tmp', 'fixture')]) {
    const call = requestWrite('fixture', target);
    await allow.click();
    await waitFor(() => replies.has(call), 'Profile boundary check did not settle');
    assert(replies.get(call).error || replies.get(call).result?.isError);
    assert.equal(await readFile(savedFile, 'utf8'), originalSettings);
    await dialog.waitFor({ state: 'hidden' });
  }
  for (const decision of ['deny', 'allow']) {
    const current = 'current-' + decision;
    const currentCall = requestWrite(current);
    await allow.waitFor();
    const id = await pendingId();
    assert(id);
    await chooseMode(/始终允许/);
    assert.equal(await pendingId(), id);
    assert.equal(await page.evaluate(async () => (await window.beings.snapshot()).settings.permissionMode), 'full-access');
    const next = 'next-' + decision;
    if (decision === 'allow') {
      await app.evaluate(({ dialog }) => {
        dialog.showOpenDialog = () => new Promise(resolve => {
          globalThis.finishFixturePicker = () => resolve({ canceled: true, filePaths: [] });
        });
      });
      await page.evaluate(() => { void window.beings.associateApp({ id: 'fixture', name: 'fixture' }); });
      await waitFor(() => app.evaluate(() => Boolean(globalThis.finishFixturePicker)), 'File picker did not acquire the settings queue');
    }
    const nextCall = requestWrite(next);
    await waitFor(() => replies.has(nextCall), 'Next Rust call did not use the new permission mode');
    assert.equal(await readFile(path.join(temporary, next + '.txt'), 'utf8'), next);
    if (decision === 'allow') await app.evaluate(() => globalThis.finishFixturePicker());
    assert.equal(await pendingId(), id);
    assert(!replies.has(currentCall));
    const currentFile = path.join(temporary, current + '.txt');
    await assert.rejects(readFile(currentFile), { code: 'ENOENT' });
    await (decision === 'deny' ? deny : allow).click();
    await waitFor(() => replies.has(currentCall), 'Original Rust call did not settle');
    if (decision === 'deny') {
      const reply = replies.get(currentCall);
      assert(reply.error || reply.result?.isError, JSON.stringify(reply));
      await assert.rejects(readFile(currentFile), { code: 'ENOENT' });
      // Model a previously planned request that reaches Desktop after the
      // policy change. Use it to switch this same process back to supervised.
      const queued = requestApproval(true);
      await allow.waitFor();
      await chooseMode(/每次询问/);
      await deny.click();
      assert.deepEqual(await queued, { text: 'deny' });
    } else {
      assert.equal(await readFile(currentFile, 'utf8'), current);
    }
    await dialog.waitFor({ state: 'hidden' });
  }
  console.log('PASS: same packaged Rust process, explicit deny and allow after promotion, next write uses saved mode while original request is pending.');
  await app.close();
  app = undefined;
  const offline = requestWrite('after-desktop-quit');
  await waitFor(() => replies.has(offline), 'Background write did not finish after Desktop quit');
  assert.equal(await readFile(path.join(temporary, 'after-desktop-quit.txt'), 'utf8'), 'after-desktop-quit');
  const saved = JSON.parse(await readFile(savedFile, 'utf8'));
  delete saved.fullAccessProof;
  await writeFile(savedFile, JSON.stringify(saved));
  const unsigned = requestWrite('unsigned-mode');
  await waitFor(() => replies.has(unsigned), 'Unsigned permission fixture did not settle');
  assert(replies.get(unsigned).error || replies.get(unsigned).result?.isError);
  await assert.rejects(readFile(path.join(temporary, 'unsigned-mode.txt')), { code: 'ENOENT' });
  console.log('PASS: next write while a settings transaction is blocked, background write after Desktop quit, unsigned full-access setting fails closed.');

  let log;
  const fields = (event, id) => '"event":"' + event + '","id":"' + id + '"';
  await waitFor(async () => {
    log = await readFile(logFile, 'utf8');
    return log.includes(fields('closed', repeatId) + ',"suppressedRepeats":2')
      && queuedRepeatIds.every(id => log.includes(fields('closed', id) + ',"suppressedRepeats":1'))
      && log.includes(fields('settled', nativeCloseId) + ',"source":"window-close","outcome":"denied"')
      && log.includes(fields('received', recoveredId) + ',"source":"pending"');
  }, 'Approval diagnostics were not persisted');
  for (const event of ['requested', 'publish-sent', 'received', 'opened', 'submitting', 'answer-received', 'settled', 'answer-acknowledged']) {
    assert(log.includes(fields(event, repeatId)), event + ' missing from the approval trace');
  }
  assert(!log.includes('approval-test-payload'));
  console.log('PASS: packaged Electron approval focus, Enter/Tab, held Enter across chat and modal, held Enter/Escape/Space across approvals, mouse, settings, native close and reopen for queued or later approvals, reload recovery and persisted logs.');
} catch (error) {
  const diagnostics = await readFile(path.join(profile, 'logs/client-errors.log'), 'utf8').catch(() => '');
  if (diagnostics) console.error(diagnostics.slice(-8000));
  const runtime = await readFile(path.join(profile, 'logs/client-runtime.log'), 'utf8').catch(() => '');
  console.error(runtime.split('\n').filter(line => line.startsWith('[approval-ui]')).slice(-14).join('\n'));
  throw error;
} finally {
  if (engine?.pid && engine.exitCode === null && engine.signalCode === null) {
    const exited = once(engine, 'exit');
    engine.kill();
    await exited;
  }
  if (sockets) { for (const socket of sockets.clients) socket.terminate(); sockets.close(); }
  if (app) await app.close();
  server.close();
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
