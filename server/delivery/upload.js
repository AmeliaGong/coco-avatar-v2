// 1v1 转写的文件上传：把飞书/腾讯会议导出的文件变成转写文本。
//
// **不支持 multipart** —— 用 express.raw 收原始字节，文件名走 X-File-Name 头。
// 少一个依赖少一份攻击面；前端把 File 直接当 body 送就行。
//
// 支持：.txt / .md（UTF-8 直读）、.docx（mammoth 提取）。
// 不支持：.doc（老格式）、.pdf —— 报错里直接告诉教练怎么转，别让他猜。

import mammoth from 'mammoth';

export const UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

const TEXT_EXT = ['txt', 'md', 'markdown', 'text'];

export function detectUploadKind(filename) {
  const name = typeof filename === 'string' ? filename.trim() : '';
  if (!name) return null;
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!m) return null;
  const ext = m[1];
  if (TEXT_EXT.includes(ext)) return 'text';
  if (ext === 'docx') return 'docx';
  return null;
}

// 从上传的文件里提取转写文本。
//
// **返回 warnings 而不是静默处理**：docx 里的说话人标记、表格、页眉页脚
// 都可能让提取结果变形，教练得知道「这份可能有噪音」。
export async function extractTranscriptFromUpload({ buffer, filename }) {
  const kind = detectUploadKind(filename);
  if (!kind) {
    throw new Error(
      `不认识的文件格式「${filename || '未知'}」。请另存为 .txt / .md，或把 .docx 直接传上来（老 .doc 和 PDF 请先在飞书/腾讯会议里导出成 docx）。`
    );
  }
  if (!buffer || !buffer.length) throw new Error('文件是空的');
  if (buffer.length > UPLOAD_MAX_BYTES) {
    throw new Error('文件超过 5MB，请拆成几段分别上传');
  }

  if (kind === 'text') {
    const text = buffer.toString('utf8');
    if (!text.trim()) throw new Error('文件里没有文字');
    return { text, kind, warnings: [] };
  }

  // docx
  const result = await mammoth.extractRawText({ buffer });
  const text = (result?.value || '').trim();
  if (!text) throw new Error('docx 里没有提取到文字（可能是纯图片，OCR 不在支持范围内）');
  const warnings = [];
  if (Array.isArray(result?.messages) && result.messages.length) {
    warnings.push(`docx 提取有 ${result.messages.length} 条提示，可能有格式丢失，请检查下面预览`);
  }
  if (!/[，。！？,.!?]/.test(text)) {
    warnings.push('提取出来的文字没有标点，可能不是转写正文，请检查');
  }
  return { text, kind, warnings };
}
