import './helpers/testEnv.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectUploadKind, extractTranscriptFromUpload } from '../server/delivery/upload.js';

test('txt / md 认得出来', () => {
  assert.equal(detectUploadKind('咨询记录.txt'), 'text');
  assert.equal(detectUploadKind('咨询记录.md'), 'text');
  assert.equal(detectUploadKind('/path/to/咨询记录.TXT'), 'text');
});

test('docx 认得出来', () => {
  assert.equal(detectUploadKind('飞书导出.docx'), 'docx');
});

test('不认识的后缀直接判 null', () => {
  assert.equal(detectUploadKind('照片.jpg'), null);
  assert.equal(detectUploadKind('没有后缀'), null);
});

test('txt 上传：内容原样出来', async () => {
  const buf = Buffer.from('来访者：我一停下来就慌。\n教练：那你试过什么？', 'utf8');
  const r = await extractTranscriptFromUpload({ buffer: buf, filename: 'a.txt' });
  assert.equal(r.kind, 'text');
  assert.ok(r.text.includes('我一停下来就慌'));
  assert.equal(r.warnings.length, 0);
});

test('空文件要报错', async () => {
  await assert.rejects(
    () => extractTranscriptFromUpload({ buffer: Buffer.alloc(0), filename: 'a.txt' }),
    /空/,
  );
});

test('不认识的后缀要报错，报错里说清怎么转', async () => {
  await assert.rejects(
    () => extractTranscriptFromUpload({ buffer: Buffer.from('x'), filename: 'a.pdf' }),
    /docx|txt/,
  );
});

test('只有空白字符的 txt 也是空文件', async () => {
  await assert.rejects(
    () => extractTranscriptFromUpload({ buffer: Buffer.from('   \n  '), filename: 'a.txt' }),
    /没有文字/,
  );
});

test('docx 字节不是真 docx 时报错，而不是崩掉', async () => {
  await assert.rejects(
    () => extractTranscriptFromUpload({ buffer: Buffer.from('not a docx at all'), filename: 'a.docx' }),
  );
});
