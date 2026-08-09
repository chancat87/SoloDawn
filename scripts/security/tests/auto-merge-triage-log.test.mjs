// 守卫逻辑的单测。夹具是从 CNB 接口上抓下来的真实响应形状 —— 特别是
// `filename` 只有 basename、完整路径只在 contents_url 里这一点，是踩过的坑。
//
// 跑： node --test scripts/security/tests/
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TRIAGE_LOG_PATH,
  TRIAGE_SCHEMA,
  checkChangedFiles,
  checkTriageLogContent,
  pathFromContentsUrl,
} from '../auto-merge-triage-log.mjs';

const contentsUrl = (path, ref = 'deadbeef') =>
  `https://api.cnb.cool/huanchong-AI/solodawn/-/git/contents/${path}?ref=${ref}`;

// PR #28 的真实形状：filename 是 basename，路径只能从 contents_url 取。
const triageLogFile = {
  sha: '5009cd928e48ec696993c361cc8762401c76e67a',
  filename: 'triage-log.json',
  status: 'modify',
  additions: 9,
  deletions: 1,
  contents_url: contentsUrl(TRIAGE_LOG_PATH),
};

test('从 contents_url 解析仓库相对路径', () => {
  assert.equal(pathFromContentsUrl(contentsUrl(TRIAGE_LOG_PATH)), TRIAGE_LOG_PATH);
  assert.equal(pathFromContentsUrl(contentsUrl('scripts/security/verify-fix.sh')),
    'scripts/security/verify-fix.sh');
  assert.equal(pathFromContentsUrl('https://api.cnb.cool/x/-/pulls/1'), null);
  assert.equal(pathFromContentsUrl(undefined), null);
});

test('只改审计日志的 PR 放行', () => {
  assert.deepEqual(checkChangedFiles([triageLogFile]), { ok: true });
});

test('多文件 PR 一律拦下（PR #23 的真实形状：5 个文件）', () => {
  const files = [
    '.cnb.yml',
    '.security/README.md',
    '.security/policy.yml',
    'scripts/security/verify-fix.sh',
    'sonar-project.properties',
  ].map((p) => ({ filename: p.split('/').pop(), status: 'modify', contents_url: contentsUrl(p) }));
  const r = checkChangedFiles(files);
  assert.equal(r.ok, false);
  assert.match(r.reason, /5 个文件/);
});

test('同名但不同目录的文件不得被放行', () => {
  // filename 一模一样，只有真实路径不同 —— 按 filename 判定就会漏掉这个。
  const r = checkChangedFiles([{
    filename: 'triage-log.json',
    status: 'modify',
    contents_url: contentsUrl('crates/services/triage-log.json'),
  }]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /crates\/services\/triage-log\.json/);
});

test('新增或删除文件不得被放行，只允许修改', () => {
  for (const status of ['add', 'delete', 'rename', undefined]) {
    const r = checkChangedFiles([{ ...triageLogFile, status }]);
    assert.equal(r.ok, false, `status=${status} 应被拦下`);
  }
});

test('拿不到路径就拦下，不猜', () => {
  assert.equal(checkChangedFiles([{ filename: 'triage-log.json', status: 'modify' }]).ok, false);
  assert.equal(checkChangedFiles([]).ok, false);
  assert.equal(checkChangedFiles(null).ok, false);
  assert.equal(checkChangedFiles({ list: [] }).ok, false);
});

const base64 = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');

test('合法审计日志内容放行', () => {
  const body = { encoding: 'base64', content: base64({ schema: TRIAGE_SCHEMA, entries: {} }) };
  assert.deepEqual(checkTriageLogContent(body), { ok: true });
});

test('内容坏了或 schema 被换掉一律拦下', () => {
  assert.equal(checkTriageLogContent({
    encoding: 'base64',
    content: Buffer.from('{ not json', 'utf8').toString('base64'),
  }).ok, false);
  assert.equal(checkTriageLogContent({
    encoding: 'base64',
    content: base64({ schema: 'something-else', entries: {} }),
  }).ok, false);
  assert.equal(checkTriageLogContent({ encoding: 'utf8', content: '{}' }).ok, false);
  assert.equal(checkTriageLogContent(null).ok, false);
});
