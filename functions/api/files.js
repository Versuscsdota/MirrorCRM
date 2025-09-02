import { json, badRequest, notFound, forbidden } from '../_utils.js';
import { requireRole, newId, auditLog } from '../_utils.js';

// file meta in KV: file:<id>
// object in R2: files/<modelId>/<id>

// Validation helpers
const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif',
  'application/pdf', 'text/plain', 'text/csv',
  'application/zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  // audio
  'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/mp3',
  // video
  'video/mp4', 'video/webm', 'video/ogg'
]);
const BLOCKED_EXT = new Set(['.exe','.bat','.cmd','.sh','.js','.msi','.dll']);
function getExt(name){ const m = /\.([A-Za-z0-9]{1,8})$/.exec(name || ''); return m ? ('.' + m[1].toLowerCase()) : ''; }
function sanitizeName(name){
  let s = (name || '').toString();
  s = s.replace(/[\n\r\t\\/]+/g,' ').replace(/[\x00-\x1F\x7F]/g,'');
  s = s.trim().slice(0, 80);
  if (!s) s = 'file';
  return s;
}
function encodeRFC5987(str) {
  return encodeURIComponent(str).replace(/['()]/g, escape).replace(/\*/g, '%2A');
}

export async function GET(env, request) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  const modelId = url.searchParams.get('modelId');
  const slotId = url.searchParams.get('slotId');

  if (id) {
    // Access by id: only root/admin
    const meta = await env.CRM_KV.get(`file:${id}`, { type: 'json' });
    if (!meta) return notFound('file');
    const { error } = await requireRole(env, request, ['root','admin','interviewer']);
    if (error) return error;
    const obj = await env.CRM_FILES.get(meta.objectKey);
    if (!obj) return notFound('file-object');
    // If download requested, require root
    const isDownload = url.searchParams.get('download') === '1';
    if (isDownload) {
      const { error } = await requireRole(env, request, ['root']);
      if (error) return error;
    }
    // Build safe filename with extension for better UX
    const ct = meta.contentType || 'application/octet-stream';
    const extMap = {
      'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
      'application/pdf': '.pdf', 'text/plain': '.txt', 'text/csv': '.csv', 'application/zip': '.zip',
      'application/msword': '.doc',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx'
    };
    const wantedExt = extMap[ct] || '';
    let baseSafe = sanitizeName(meta.name || `file-${id}`);
    const hasExt = /\.[A-Za-z0-9]{1,8}$/.test(baseSafe);
    if (!hasExt && wantedExt) baseSafe += wantedExt;
    const safeName = baseSafe;
    const inline = !isDownload;
    const dispo = `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeRFC5987(safeName)}`;
    return new Response(obj.body, { headers: {
      'content-type': ct,
      'content-length': String(meta.size || 0),
      'content-disposition': dispo,
      'cache-control': 'no-store, no-cache, must-revalidate',
      'pragma': 'no-cache'
    } });
  }

  // Listing
  if (modelId) {
    const { error } = await requireRole(env, request, ['root','admin','interviewer']);
    if (error) return error;
    // Try indexed listing first
    const idx = await env.CRM_KV.list({ prefix: `file_model:${modelId}:` });
    let metas = [];
    if (idx.keys && idx.keys.length) {
      metas = await Promise.all(idx.keys.map(k => {
        const id = k.name.split(':').pop();
        return env.CRM_KV.get(`file:${id}`, { type: 'json' });
      }));
    } else {
      // Fallback for legacy entries
      const list = await env.CRM_KV.list({ prefix: 'file:' });
      metas = await Promise.all(list.keys.map(k => env.CRM_KV.get(k.name, { type: 'json' })));
      metas = metas.filter(f => f && f.entity === 'model' && f.modelId === modelId);
    }
    const items = (metas || []).filter(Boolean).map(f => ({ ...f, url: `/api/files?id=${f.id}` }));
    items.sort((a,b)=> b.createdAt - a.createdAt);
    return json({ items });
  }

  if (slotId) {
    const { error } = await requireRole(env, request, ['root','admin','interviewer']);
    if (error) return error;
    const idx = await env.CRM_KV.list({ prefix: `file_slot:${slotId}:` });
    let metas = [];
    if (idx.keys && idx.keys.length) {
      metas = await Promise.all(idx.keys.map(k => {
        const id = k.name.split(':').pop();
        return env.CRM_KV.get(`file:${id}`, { type: 'json' });
      }));
    } else {
      const list = await env.CRM_KV.list({ prefix: 'file:' });
      metas = await Promise.all(list.keys.map(k => env.CRM_KV.get(k.name, { type: 'json' })));
      metas = metas.filter(f => f && f.entity === 'slot' && f.slotId === slotId);
    }
    const items = (metas || []).filter(Boolean).map(f => ({ ...f, url: `/api/files?id=${f.id}` }));
    items.sort((a,b)=> b.createdAt - a.createdAt);
    return json({ items });
  }

  return badRequest('modelId or slotId required');
}

export async function POST(env, request) {
  // Uploads: root/admin/interviewer

  if (!request.headers.get('content-type')?.includes('multipart/form-data')) return badRequest('multipart/form-data required');
  const fd = await request.formData();
  const modelId = fd.get('modelId');
  const slotId = fd.get('slotId');
  const files = (typeof fd.getAll === 'function') ? fd.getAll('file') : [fd.get('file')].filter(Boolean);
  const nameSingle = (fd.get('name') || '').toString();
  const description = (fd.get('description') || '').toString();
  const category = (fd.get('category') || '').toString().trim(); // optional: e.g., 'doc' | 'photo'
  if ((!modelId && !slotId) || !files || files.length === 0) return badRequest('modelId or slotId and at least one file required');

  const MAX_BYTES = Number(env.MAX_UPLOAD_BYTES || 50 * 1024 * 1024);
  const MAX_FILES = Number(env.MAX_FILES_PER_UPLOAD || 10);
  if (files.length > MAX_FILES) return forbidden(`Слишком много файлов за один раз (макс ${MAX_FILES})`);

  let entity = null;
  const { sess, error: upErr } = await requireRole(env, request, ['root','admin','interviewer']);
  if (upErr) return upErr;
  if (modelId) {
    const model = await env.CRM_KV.get(`model:${modelId}`);
    if (!model) return notFound('model');
    // Interviewers ARE allowed to upload to models
    entity = { type: 'model', id: modelId };
  } else {
    // Slot uploads are allowed for root/admin/interviewer
    const { error: slotErr } = await requireRole(env, request, ['root','admin','interviewer']);
    if (slotErr) return slotErr;
    entity = { type: 'slot', id: slotId };
  }

  const created = [];
  for (const f of files) {
    const size = f.size ?? 0;
    if (size > MAX_BYTES) return forbidden(`Размер файла превышает лимит ${Math.round(MAX_BYTES/1024/1024)} МБ`);
    // Type and extension validation
    const contentType = f.type || 'application/octet-stream';
    if (contentType && !ALLOWED_MIME.has(contentType)) {
      return forbidden('Недопустимый тип файла');
    }
    // Determine name: explicit name field or file name
    let name = sanitizeName(nameSingle || f.name || 'file');
    const ext = getExt(name);
    if (ext && BLOCKED_EXT.has(ext)) return forbidden('Запрещённое расширение файла');

    const id = newId('fil');
    const objectKey = entity.type === 'model' ? `files/models/${entity.id}/${id}` : `files/slots/${entity.id}/${id}`;
    await env.CRM_FILES.put(objectKey, f.stream(), { httpMetadata: { contentType } });

    const baseMeta = { id, name, description, objectKey, contentType, size, createdAt: Date.now() };
    const meta = entity.type === 'model'
      ? { ...baseMeta, entity: 'model', modelId: entity.id, category: category || undefined }
      : { ...baseMeta, entity: 'slot', slotId: entity.id, category: category || undefined };
    await env.CRM_KV.put(`file:${id}`, JSON.stringify(meta));
    if (entity.type === 'model') {
      await env.CRM_KV.put(`file_model:${entity.id}:${id}`, '1');
    } else {
      await env.CRM_KV.put(`file_slot:${entity.id}:${id}`, '1');
    }
    created.push({ ...meta, url: `/api/files?id=${id}` });
  }

  try {
    await auditLog(env, request, sess, 'files_upload', {
      count: created.length,
      entity: entity.type,
      modelId: entity.type === 'model' ? entity.id : undefined,
      slotId: entity.type === 'slot' ? entity.id : undefined,
      names: created.slice(0, 5).map(x => x.name)
    });
  } catch {}
  if (created.length === 1) return json({ ok: true, file: created[0] });
  return json({ ok: true, files: created });
}

export async function DELETE(env, request) {
  const { sess, error } = await requireRole(env, request, ['root','admin','interviewer']);
  if (error) return error;
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id) return badRequest('id required');
  const meta = await env.CRM_KV.get(`file:${id}`, { type: 'json' });
  if (!meta) return notFound('file');
  await env.CRM_FILES.delete(meta.objectKey);
  await env.CRM_KV.delete(`file:${id}`);
  // cleanup index
  if (meta.entity === 'model') {
    await env.CRM_KV.delete(`file_model:${meta.modelId}:${id}`);
  } else if (meta.entity === 'slot') {
    await env.CRM_KV.delete(`file_slot:${meta.slotId}:${id}`);
  }
  await auditLog(env, request, sess, 'file_delete', { id, entity: meta.entity, modelId: meta.modelId, slotId: meta.slotId, name: meta.name });
  return json({ ok: true });
}
