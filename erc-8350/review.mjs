// SPDX-License-Identifier: CC0-1.0
// Ted (@haot3x). Independently written local transaction tests; no project SDK or test imports.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AbiCoder, Contract, ContractFactory, JsonRpcProvider, NonceManager, TypedDataEncoder,
  Wallet, ZeroAddress, ZeroHash, concat, id, keccak256 } from 'ethers';

const root = dirname(fileURLToPath(import.meta.url));
const safePin = 'bf943f80fec5ac647159d26161446ac5d716a294';
const forge = process.env.FORGE_BIN || 'forge';
const anvilBin = process.env.ANVIL_BIN || 'anvil';
const resultDir = resolve(root, 'results');
mkdirSync(resultDir, { recursive: true });
const report = { author: 'Ted (@haot3x)', result: 'fail', network: 'ephemeral-local-anvil',
  registryRevision: '8b11215cf267f710b49ea003384e678bcf953eae', safeRevision: safePin,
  compiler: '0.8.24', compilerEvm: 'cancun', executionEvm: 'prague', cases: [], receipts: [] };
let node, provider, runner, registry, delegate, fixture, safe, handler, messageLibrary;
let logs = '', sequence = 0;
const abi = AbiCoder.defaultAbiCoder();
// Public local test keys only. The runner creates its own loopback node and takes no RPC URL.
const key = n => `0x${n.toString(16).padStart(64, '0')}`;
const authority = new Wallet(key(0x8350));
const ownerA = new Wallet(key(0x8351)), ownerB = new Wallet(key(0x8352));
const types = {
  MemorySpace: [{ name: 'initialController', type: 'address' }, { name: 'salt', type: 'bytes32' }],
  SpaceRegistration: [{ name: 'spaceId', type: 'bytes32' }, { name: 'controller', type: 'address' }, { name: 'authorizer', type: 'address' }],
  SpaceAuthorization: [{ name: 'spaceId', type: 'bytes32' }, { name: 'newController', type: 'address' }, { name: 'newAuthorizer', type: 'address' }, { name: 'nonce', type: 'uint64' }],
  ExperienceDelta: [{ name: 'spaceId', type: 'bytes32' }, { name: 'sequence', type: 'uint64' }, { name: 'prevStateRoot', type: 'bytes32' }, { name: 'deltaCommitment', type: 'bytes32' }, { name: 'provenanceCommitment', type: 'bytes32' }, { name: 'profileId', type: 'bytes32' }, { name: 'locatorCommitment', type: 'bytes32' }],
};
const sig = (wallet, digest) => wallet.signingKey.sign(digest).serialized;
const stringify = v => JSON.stringify(v, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2);

function command(bin, args, cwd = root) {
  const p = spawnSync(bin, args, { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  logs += `$ ${bin} ${args.join(' ')}\n${p.stdout || ''}${p.stderr || ''}\n`;
  if (p.error || p.status !== 0) throw new Error(`${bin} failed: ${p.error?.message || p.stderr || p.stdout}`);
  return p.stdout.trim();
}
function artifact(file, name) {
  return JSON.parse(readFileSync(resolve(root, `out/${file}.sol/${name}.json`)));
}
async function deploy(file, name, args = []) {
  const a = artifact(file, name);
  const c = await new ContractFactory(a.abi, a.bytecode.object, runner).deploy(...args);
  await c.waitForDeployment();
  return c;
}
async function transact(to, data, accepted = true, extra = {}) {
  const tx = await runner.sendTransaction({ to, data, gasLimit: 1_500_000n, ...extra });
  let receipt;
  try { receipt = await tx.wait(); }
  catch (e) { if (!e.receipt) throw e; receipt = e.receipt; }
  report.receipts.push(receipt.toJSON());
  assert.equal(receipt.status, accepted ? 1 : 0, `${tx.hash}: unexpected receipt status`);
  if (!accepted) assert.equal(receipt.logs.length, 0, 'rejected transaction left persisted logs');
  return receipt;
}
async function check(name, fn) {
  try { await fn(); report.cases.push({ name, result: 'pass' }); console.log(`PASS ${name}`); }
  catch (e) { report.cases.push({ name, result: 'fail', error: e.message }); throw e; }
}
function digest(type, value, target = registry.target, chainId = 31337) {
  return TypedDataEncoder.hash({ name: 'AgentMemoryState', version: '1', chainId, verifyingContract: target }, { [type]: types[type] }, value);
}
function registration(account, target = registry) {
  const salt = id(`Ted/ERC8350/${++sequence}`);
  const spaceId = TypedDataEncoder.hashStruct('MemorySpace', { MemorySpace: types.MemorySpace }, { initialController: account, salt });
  const value = { spaceId, controller: account, authorizer: account };
  return { op: 'register', spaceId, type: 'SpaceRegistration', value, target,
    digest: digest('SpaceRegistration', value, target.target),
    data: s => target.interface.encodeFunctionData('registerSpace', [spaceId, account, account, salt, s]) };
}
function safeDigest(d) {
  return TypedDataEncoder.hash({ chainId: 31337, verifyingContract: safe.target },
    { SafeMessage: [{ name: 'message', type: 'bytes' }] }, { message: abi.encode(['bytes32'], [d]) });
}
function ownersSignature(d) {
  return concat([ownerA, ownerB].sort((a, b) => a.address.toLowerCase().localeCompare(b.address.toLowerCase())).map(w => sig(w, d)));
}
async function configure(wallet, mode, d = ZeroHash, s = '0x') {
  await transact(wallet.target, wallet.interface.encodeFunctionData('configure', [mode, d, keccak256(s)]));
}
async function bootstrap(c, kind) {
  let s;
  if (kind === 'safe') s = ownersSignature(safeDigest(c.digest));
  else if (kind === 'fixture') { s = '0xbeef'; await configure(fixture, 5, c.digest, s); }
  else s = sig(authority, c.digest);
  await transact(c.target.target, c.data(s));
}
async function scenario(op, kind) {
  const account = kind === 'safe' ? safe.target : kind === 'fixture' ? fixture.target : authority.address;
  const c = registration(account);
  if (op === 'register') return c;
  await bootstrap(c, kind);
  const value = op === 'rotate'
    ? { spaceId: c.spaceId, newController: account, newAuthorizer: ownerB.address, nonce: 1 }
    : { spaceId: c.spaceId, sequence: 1, prevStateRoot: ZeroHash, deltaCommitment: id('private delta'), provenanceCommitment: ZeroHash, profileId: id('test profile'), locatorCommitment: ZeroHash };
  const type = op === 'rotate' ? 'SpaceAuthorization' : 'ExperienceDelta';
  return { ...c, op, type, value, digest: digest(type, value),
    data: s => op === 'rotate'
      ? registry.interface.encodeFunctionData('updateSpaceAuthorization', [c.spaceId, account, ownerB.address, s])
      : registry.interface.encodeFunctionData('commitTransition', [value, s]) };
}
async function snapshot(c) {
  let head, authorization;
  try { head = Array.from(await c.target.head(c.spaceId)); }
  catch (e) {
    assert.equal(e.code, 'CALL_EXCEPTION');
    assert.equal(c.target.interface.parseError(e.data)?.name, 'UnknownSpace');
    return 'unknown-space';
  }
  authorization = Array.from(await c.target.spaceAuthorization(c.spaceId));
  const transition = c.op === 'commit'
    ? Array.from(await c.target.transition(TypedDataEncoder.hashStruct(c.type, { [c.type]: types[c.type] }, c.value))) : null;
  return stringify({ head, authorization, transition });
}
async function reject(c, s, fromWallet = null) {
  const before = await snapshot(c);
  const to = fromWallet ? fromWallet.target : c.target.target;
  const data = fromWallet ? fromWallet.interface.encodeFunctionData('forward', [c.target.target, c.data(s)]) : c.data(s);
  await transact(to, data, false);
  assert.equal(await snapshot(c), before, 'rejection changed registry state');
}
async function accept(c, s) {
  await transact(c.target.target, c.data(s));
  const a = await c.target.spaceAuthorization(c.spaceId);
  const h = await c.target.head(c.spaceId);
  if (c.op === 'rotate') {
    assert.equal(a[0], c.value.newController); assert.equal(a[1], c.value.newAuthorizer); assert.equal(a[2], BigInt(c.value.nonce));
    assert.deepEqual(Array.from(h), [ZeroHash, ZeroHash, 0n]);
  } else if (c.op === 'commit') {
    const tid = TypedDataEncoder.hashStruct(c.type, { [c.type]: types[c.type] }, c.value);
    const stateRoot = keccak256(abi.encode(['bytes32', 'bytes32', 'bytes32'], [id('MemoryState(bytes32 prevStateRoot,bytes32 transitionId)'), ZeroHash, tid]));
    assert.deepEqual(Array.from(h), [tid, stateRoot, 1n]);
    const record = await c.target.transition(tid);
    assert.equal(record[0], c.spaceId); assert.equal(record[1], stateRoot); assert.equal(record[2], 1n);
  } else {
    assert.equal(a[0], c.value.controller); assert.equal(a[1], c.value.authorizer); assert.equal(a[2], 0n);
    assert.deepEqual(Array.from(h), [ZeroHash, ZeroHash, 0n]);
  }
}
async function approveSafeMessage(d) {
  const data = messageLibrary.interface.encodeFunctionData('signMessage', [abi.encode(['bytes32'], [d])]);
  const value = { to: messageLibrary.target, value: 0, data, operation: 1, safeTxGas: 0, baseGas: 0,
    gasPrice: 0, gasToken: ZeroAddress, refundReceiver: ZeroAddress, nonce: await safe.nonce() };
  const txTypes = { SafeTx: [ ['to', 'address'], ['value', 'uint256'], ['data', 'bytes'], ['operation', 'uint8'],
    ['safeTxGas', 'uint256'], ['baseGas', 'uint256'], ['gasPrice', 'uint256'], ['gasToken', 'address'],
    ['refundReceiver', 'address'], ['nonce', 'uint256'] ].map(([name, type]) => ({ name, type })) };
  const dtx = TypedDataEncoder.hash({ chainId: 31337, verifyingContract: safe.target }, txTypes, value);
  await transact(safe.target, safe.interface.encodeFunctionData('execTransaction', [value.to, 0, data, 1, 0, 0, 0, ZeroAddress, ZeroAddress, ownersSignature(dtx)]));
  assert.equal(await safe.signedMessages(safeDigest(d)), 1n);
}

try {
  const manifest = JSON.parse(readFileSync(resolve(root, 'sources.json')));
  for (const [name, pin] of Object.entries(manifest.files)) {
    assert.equal(createHash('sha256').update(readFileSync(resolve(root, 'upstream', name))).digest('hex'), pin.sha256, `source pin ${name}`);
  }
  const safeDir = resolve(root, 'lib/safe');
  if (!existsSync(resolve(safeDir, '.git'))) {
    mkdirSync(safeDir, { recursive: true });
    command('git', ['init', '-q'], safeDir);
    command('git', ['fetch', '--depth=1', 'https://github.com/safe-fndn/safe-smart-account.git', safePin], safeDir);
    command('git', ['checkout', '--detach', 'FETCH_HEAD'], safeDir);
  }
  assert.equal(command('git', ['rev-parse', 'HEAD'], safeDir), safePin);
  assert.equal(command('git', ['status', '--porcelain', '--untracked-files=all'], safeDir), '', 'dirty Safe dependency');
  report.forge = command(forge, ['--version']);
  report.anvil = command(anvilBin, ['--version']);
  assert.match(report.forge, /Version: 1\.7\.1/); assert.match(report.anvil, /Version: 1\.7\.1/);
  command(forge, ['build']);
  const art = artifact('AgentMemoryStateRegistry', 'AgentMemoryStateRegistry');
  report.registryCreationCodeSha256 = createHash('sha256').update(art.bytecode.object).digest('hex');
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(done => server.close(done));
  node = spawn(anvilBin, ['--host', '127.0.0.1', '--port', String(port), '--hardfork', 'prague', '--chain-id', '31337', '--silent'], { stdio: ['ignore', 'pipe', 'pipe'] });
  node.stdout.on('data', b => { logs += b; }); node.stderr.on('data', b => { logs += b; });
  let spawnError; node.on('error', e => { spawnError = e; });
  const rpcUrl = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (spawnError) throw spawnError;
    if (node.exitCode !== null) throw new Error('Anvil exited');
    try {
      const r = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }), signal: AbortSignal.timeout(1000) });
      assert.equal((await r.json()).result, '0x7a69'); ready = true; break;
    } catch { await new Promise(done => setTimeout(done, 100)); }
  }
  assert.ok(ready, 'Anvil did not start');
  provider = new JsonRpcProvider(rpcUrl, 31337, { cacheTimeout: -1 }); provider.pollingInterval = 50;
  const payer = Wallet.fromPhrase('test test test test test test test test test test test junk').connect(provider);
  runner = new NonceManager(payer);
  registry = await deploy('AgentMemoryStateRegistry', 'AgentMemoryStateRegistry');
  fixture = await deploy('WalletPolicies', 'WalletPolicies', [payer.address]);
  const implementation = await deploy('WalletPolicies', 'WalletPolicies', [payer.address]);
  delegate = new Contract(authority.address, implementation.interface, runner);
  await check('7702: mined type-4 authorization installs rejecting wallet policy', async () => {
    const auth = await authority.authorize({ address: implementation.target, nonce: 0, chainId: 31337 });
    const receipt = await transact(authority.address, delegate.interface.encodeFunctionData('ping'), true, { authorizationList: [auth] });
    assert.equal(receipt.type, 4);
    assert.equal(await provider.send('eth_getCode', [authority.address, 'latest']), `0xef0100${implementation.target.slice(2).toLowerCase()}`);
    assert.equal(await provider.getTransactionCount(authority.address), 1);
    assert.equal(await delegate.ping(), 8350n);
  });
  const singleton = await deploy('Safe', 'Safe');
  const proxy = await deploy('SafeProxy', 'SafeProxy', [singleton.target]);
  safe = new Contract(proxy.target, singleton.interface, runner);
  handler = await deploy('CompatibilityFallbackHandler', 'CompatibilityFallbackHandler');
  messageLibrary = await deploy('SignMessageLib', 'SignMessageLib');
  await transact(safe.target, safe.interface.encodeFunctionData('setup', [[ownerA.address, ownerB.address], 2, ZeroAddress, '0x', handler.target, ZeroAddress, 0, ZeroAddress]));
  assert.equal(await safe.VERSION(), '1.4.1'); assert.equal(await safe.getThreshold(), 2n);

  for (const op of ['register', 'commit', 'rotate']) {
    for (const [mode, label] of [[0, 'wrong magic'], [1, 'revert'], [2, 'dirty padding'], [3, 'short return']]) {
      await check(`7702 ${op}: ${label} permits retained key, refuses another key`, async () => {
        await configure(delegate, 0);
        const c = await scenario(op, '7702'); await configure(delegate, mode);
        await reject(c, sig(ownerA, c.digest)); await accept(c, sig(authority, c.digest));
      });
    }
    for (const s of ['0x', '0xabcd']) {
      await check(`1271 ${op}: exact ${s === '0x' ? 'empty' : 'short'} bytes, current policy and direct caller`, async () => {
        const c = await scenario(op, 'fixture');
        await configure(fixture, 5, id('wrong digest'), s); await reject(c, s);
        await configure(fixture, 5, c.digest, s);
        await reject(c, '0xdead', fixture); // nonempty self-call must not bypass validation
        await accept(c, s);
      });
    }
    await check(`1271 ${op}: canonical first word accepts trailing return bytes`, async () => {
      const c = await scenario(op, 'fixture'); await configure(fixture, 4, c.digest, '0xabcd'); await accept(c, '0xabcd');
    });
    await check(`1271 ${op}: malformed return does not authorize an ordinary contract`, async () => {
      const c = await scenario(op, 'fixture');
      for (const mode of [0, 1, 2, 3]) { await configure(fixture, mode); await reject(c, '0xabcd'); }
      await configure(fixture, 0); await reject(c, sig(ownerA, c.digest));
    });
    await check(`Safe ${op}: 2-of-2 threshold, single signer and wrong digest rejected`, async () => {
      const c = await scenario(op, 'safe');
      await reject(c, sig(ownerA, safeDigest(c.digest)));
      await reject(c, ownersSignature(safeDigest(id('different digest'))));
      await accept(c, ownersSignature(safeDigest(c.digest)));
    });
    await check(`Safe ${op}: relayed empty signature requires signed-message approval`, async () => {
      const c = await scenario(op, 'safe'); await reject(c, '0x');
      await approveSafeMessage(id('unrelated digest')); await reject(c, '0x');
      await approveSafeMessage(c.digest); await accept(c, '0x');
    });
  }
  await check('7702: wrong chain/domain and signature replay preserve state', async () => {
    await configure(delegate, 0); const c = await scenario('commit', '7702');
    await reject(c, sig(authority, digest(c.type, c.value, registry.target, 1)));
    await reject(c, sig(authority, digest(c.type, c.value, fixture.target)));
    const s = sig(authority, c.digest); await accept(c, s); await reject(c, s);
  });
  await check('1271: approval revoked after successful simulation rejects the mined transaction', async () => {
    const c = await scenario('commit', 'fixture');
    await configure(fixture, 5, c.digest, '0xabcd');
    await provider.call({ from: payer.address, to: registry.target, data: c.data('0xabcd') });
    await configure(fixture, 0); await reject(c, '0xabcd');
    await configure(fixture, 5, c.digest, '0xabcd'); await accept(c, '0xabcd');
  });
  await check('roles: the transition authorizer cannot rotate the controller', async () => {
    await configure(delegate, 0);
    const first = await scenario('rotate', '7702'); await accept(first, sig(authority, first.digest));
    const value = { ...first.value, newController: ownerA.address, nonce: 2 };
    const c = { ...first, value, digest: digest('SpaceAuthorization', value),
      data: s => registry.interface.encodeFunctionData('updateSpaceAuthorization', [first.spaceId, ownerA.address, ownerB.address, s]) };
    await reject(c, sig(ownerB, c.digest)); await accept(c, sig(authority, c.digest));
  });
  await check('negative control: previous bytes4 decoder loses valid retained-key fallback on dirty padding', async () => {
    const original = readFileSync(resolve(root, 'upstream/AgentMemoryStateRegistry.sol'), 'utf8');
    const fixed = 'abi.decode(result, (bytes32)) == bytes32(_ERC1271_MAGIC_VALUE)';
    assert.equal(original.split(fixed).length, 2);
    const modified = original.replace(fixed, 'abi.decode(result, (bytes4)) == _ERC1271_MAGIC_VALUE')
      .replace('contract AgentMemoryStateRegistry is', 'contract NegativeRegistry is')
      .replaceAll('from "./', 'from "../upstream/');
    mkdirSync(resolve(root, '.negative-src'), { recursive: true });
    writeFileSync(resolve(root, '.negative-src/NegativeRegistry.sol'), modified);
    command(forge, ['build', '.negative-src/NegativeRegistry.sol']);
    const broken = await deploy('NegativeRegistry', 'NegativeRegistry');
    await configure(delegate, 2);
    const c = registration(authority.address, broken);
    await reject(c, sig(authority, c.digest));
    report.negativeControl = 'Single-line historical decoder mutation plus contract/import renaming; not a complete historical deployment reproduction.';
  });
  report.result = 'pass';
  report.scope = 'Independent client-side signing and mined local wallet transactions against unmodified official source; not a second registry implementation, audit or production-wallet certification.';
} catch (e) {
  report.error = e.stack || e.message; console.error(report.error); process.exitCode = 1;
} finally {
  report.generatedAt = new Date().toISOString(); report.passed = report.cases.filter(c => c.result === 'pass').length;
  report.failed = report.cases.filter(c => c.result === 'fail').length;
  writeFileSync(resolve(resultDir, 'report.json'), `${stringify(report)}\n`);
  writeFileSync(resolve(resultDir, 'tools.log'), logs);
  provider?.destroy();
  if (node && node.exitCode === null && node.pid) { const exited = once(node, 'exit'); node.kill('SIGTERM'); await exited; }
  console.log(`${report.result.toUpperCase()}: ${report.passed} passed, ${report.failed} failed`);
}
