import { json, badRequest, notFound } from '../_utils.js';
import { requireRole, newId, auditLog } from '../_utils.js';
import { normalizeStatuses, validateStatus, createStatusChangeEntry } from '../_status.js';
import { normalizeDataBlock, mergeDataBlocks, extractModelFieldsFromDataBlock } from '../_schema.js';

// KV keys
// model:<id> -> { id, name, note, fullName, age, height, weight, measurements, contacts, tags, history: [], createdAt, createdBy }

export async function GET(env, request) {
  const { sess, error } = await requireRole(env, request, ['root','admin','interviewer']);
  if (error) return error;
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (id) {
    const model = await env.CRM_KV.get(`model:${id}`, { type: 'json' });
    if (!model) return notFound('model');
    // ensure statuses are present with defaults
    const out = normalizeStatuses(model);
    // Derive registeredAt for response if missing
    try {
      if (out && out.registration) {
        if (!out.registration.registeredAt) {
          const regHist = Array.isArray(out.history) ? out.history.find(h => h && h.type === 'registration' && h.ts) : null;
          if (regHist && regHist.ts) out.registration.registeredAt = regHist.ts;
        }
      }
    } catch {}
    return json(out);
  }
  const list = await env.CRM_KV.list({ prefix: 'model:' });
  const fetched = await Promise.all(list.keys.map(k => env.CRM_KV.get(k.name, { type: 'json' })));
  const itemsRaw = fetched.filter(Boolean);
  const items = itemsRaw.map(m => {
    const out = normalizeStatuses(m);
    try {
      if (out && out.registration && !out.registration.registeredAt) {
        const regHist = Array.isArray(out.history) ? out.history.find(h => h && h.type === 'registration' && h.ts) : null;
        if (regHist && regHist.ts) out.registration.registeredAt = regHist.ts;
      }
    } catch {}
    if (sess && sess.user && sess.user.role === 'interviewer') {
      if ('webcamAccounts' in out) delete out.webcamAccounts; // hide only in list for interviewer
    }
    return out;
  });
  items.sort((a,b) => b.createdAt - a.createdAt);
  return json({ items });
}

export async function POST(env, request) {
  // Read body first to determine action-specific role permissions
  let body; try { body = await request.json(); } catch { return badRequest('Expect JSON'); }
  const allowed = (body && body.action === 'registerFromSlot')
    ? ['root','admin','interviewer']
    : ['root','admin'];
  const { sess, error } = await requireRole(env, request, allowed);
  if (error) return error;

  // Action: register new model directly from a slot with full registration data
  if (body.action === 'registerFromSlot') {
    const date = (body.date || '').trim();
    const slotId = (body.slotId || '').trim();
    if (!date || !slotId) return badRequest('date and slotId required');
    const slot = await env.CRM_KV.get(`slot:${date}:${slotId}`, { type: 'json' });
    if (!slot) return notFound('slot');

    // Keep model name based on provided name or slot title; fullName is separate
    const name = (body.name || slot.title || '').trim();
    if (!name) return badRequest('name required');
    const fullName = (body.fullName || name).trim();
    const phone = (body.phone || '').trim();
    const birthDate = (body.birthDate || '').trim();
    const docType = (body.docType || '').trim(); // passport | driver | foreign
    const docNumber = (body.docNumber || '').trim();
    const internshipDate = (body.internshipDate || '').trim();
    const regComment = (body.comment || '').trim();
    const id = newId('mdl');
    const now = Date.now();

    // Sanitize incoming statuses with fallback to slot; no auto-assignment
    const rawStatuses = {
      status1: body.status1 || slot.status1 || 'not_confirmed',
      status2: body.status2 || slot.status2,
      status3: body.status3 || slot.status3,
      // explicit status4 may be passed, but for registration action we set it below
      status4: body.status4
    };
    const { status1: s1, status2: s2, status3: s3 } = normalizeStatuses(rawStatuses);
    const s4 = 'registration';

    // Merge data_block: slot + incoming
    const mergedDataBlock = mergeDataBlocks(slot.data_block, body.dataBlock, { recordEdit: true, editedBy: sess.user.id });
    // Extract known fields from merged data_block to fill missing explicit inputs
    const dbFields = extractModelFieldsFromDataBlock(mergedDataBlock);

    const model = {
      id,
      name,
      note: regComment,
      fullName: fullName || dbFields.fullName || '',
      contacts: { phone: phone || dbFields.phone || '' },
      tags: [],
      history: [],
      comments: [],
      mainPhotoId: null,
      createdAt: now,
      createdBy: sess.user.id,
      data_block: mergedDataBlock,
      // Registration snapshot
      registration: {
        registeredAt: now,
        slotRef: { id: slot.id, date: slot.date, start: slot.start, end: slot.end, title: slot.title },
        birthDate,
        docType: docType || null,
        docNumber: docNumber || null,
        internshipDate: internshipDate || null,
        comment: regComment || '',
        // duplicate key fields that were provided at registration time for clearer audit
        fullName,
        phone,
        // include statuses snapshot as part of registration
        statuses: {
          status1: s1,
          ...(s2 ? { status2: s2 } : {}),
          ...(s3 ? { status3: s3 } : {}),
          status4: s4
        }
      },
      // propagate statuses (request preferred, fallback slot)
      status1: s1,
      status2: s2,
      status3: s3,
      status4: s4
    };

    // initial history with registration snapshot and statuses for timeline
    model.history.push({
      ts: now,
      type: 'registration',
      slot: { id: slot.id, date: slot.date, start: slot.start, end: slot.end, title: slot.title },
      statuses: { status1: s1, ...(s2 ? { status2: s2 } : {}), ...(s3 ? { status3: s3 } : {}), status4: s4 },
      registration: {
        birthDate: birthDate || null,
        docType: docType || null,
        docNumber: docNumber || null,
        internshipDate: internshipDate || null,
        comment: regComment || '',
        fullName,
        phone
      },
      text: (slot.interview && slot.interview.text) || ''
    });
    await env.CRM_KV.put(`model:${id}`, JSON.stringify(model));
    // link slot -> model for future status syncs and append slot history with registration event
    try {
      const slotKey = `slot:${slot.date}:${slot.id}`;
      const curSlot = await env.CRM_KV.get(slotKey, { type: 'json' });
      if (curSlot) {
        curSlot.modelId = id;
        // Append registration history on slot with user attribution and statuses snapshot
        curSlot.history = Array.isArray(curSlot.history) ? curSlot.history : [];
        curSlot.history.push({
          ts: now,
          userId: sess.user.id,
          action: 'registration',
          modelId: id,
          statuses: { status1: s1, ...(s2 ? { status2: s2 } : {}), ...(s3 ? { status3: s3 } : {}), status4: s4 }
        });
        // Also persist merged data_block back to slot if slot has none of these fields (optional light sync)
        try {
          const curDB = normalizeDataBlock(curSlot.data_block);
          const backMerged = mergeDataBlocks(curDB, mergedDataBlock, { recordEdit: true, editedBy: sess.user.id });
          curSlot.data_block = backMerged;
        } catch {}
        // If a custom name was provided that differs from slot.title, sync the slot title to the model name
        if (model.name && curSlot.title !== model.name) {
          curSlot.history = curSlot.history || [];
          curSlot.history.push({
            ts: now,
            userId: sess.user.id,
            action: 'title_sync_from_model',
            modelId: id,
            oldTitle: curSlot.title,
            newTitle: model.name
          });
          curSlot.title = model.name;
        }
        await env.CRM_KV.put(slotKey, JSON.stringify(curSlot));
      }
    } catch {}
    // Audit registration action
    try { await auditLog(env, request, sess, 'slot_register', { slotId, date, modelId: id }); } catch {}
    // Link/copy files from slot -> model (same logic as ingest)
    let linked = [];
    try {
      const filesList = await env.CRM_KV.list({ prefix: 'file:' });
      const metas = await Promise.all(filesList.keys.map(k => env.CRM_KV.get(k.name, { type: 'json' })));
      const slotFiles = metas.filter(f => f && f.entity === 'slot' && f.slotId === slotId);
      for (const f of slotFiles) {
        const nfId = newId('fil');
        const meta = { id: nfId, entity: 'model', modelId: id, name: f.name, description: f.description, objectKey: f.objectKey, contentType: f.contentType, size: f.size, createdAt: Date.now() };
        await env.CRM_KV.put(`file:${nfId}`, JSON.stringify(meta));
        await env.CRM_KV.put(`file_model:${id}:${nfId}`, '1');
        linked.push({ ...meta, url: `/api/files?id=${nfId}` });
      }
      if (linked.length) {
        model.history = model.history || [];
        model.history.push({ ts: Date.now(), type: 'files_linked_from_slot', slot: { id: slot.id, date: slot.date }, count: linked.length });
        await env.CRM_KV.put(`model:${id}`, JSON.stringify(model));
      }
    } catch {}
    return json({ ...model, files: linked });
  }

  // Action: retro-link a slot to an existing model (set registration.slotRef and slot.modelId)
  if (body.action === 'linkSlotRef') {
    const modelId = (body.modelId || '').trim();
    const date = (body.date || '').trim();
    const slotId = (body.slotId || '').trim();
    const sync = (body.sync || 'slot_to_model'); // 'slot_to_model' | 'model_to_slot' | 'none'
    if (!modelId || !date || !slotId) return badRequest('modelId/date/slotId required');
    const model = await env.CRM_KV.get(`model:${modelId}`, { type: 'json' });
    if (!model) return notFound('model');
    const slot = await env.CRM_KV.get(`slot:${date}:${slotId}`, { type: 'json' });
    if (!slot) return notFound('slot');

    // Ensure registration object and attach slotRef (include title so UI does not need to fetch slot)
    model.registration = model.registration || {};
    model.registration.slotRef = { id: slot.id, date: slot.date, start: slot.start, end: slot.end, title: slot.title };

    // Optionally sync statuses
    if (sync === 'slot_to_model') {
      const s = normalizeStatuses({ status1: slot.status1, status2: slot.status2, status3: slot.status3 });
      model.status1 = s.status1;
      model.status2 = s.status2;
      model.status3 = s.status3;
      // record history on model
      model.history = model.history || [];
      model.history.push({
        ts: Date.now(),
        type: 'status_sync_from_slot',
        userId: sess.user.id,
        slotId: slot.id,
        status1: model.status1,
        status2: model.status2,
        status3: model.status3
      });
    } else if (sync === 'model_to_slot') {
      const s = normalizeStatuses({ status1: model.status1, status2: model.status2, status3: model.status3 });
      slot.status1 = s.status1;
      slot.status2 = s.status2;
      slot.status3 = s.status3;
      // record history on slot
      slot.history = slot.history || [];
      slot.history.push({
        ts: Date.now(),
        userId: sess.user.id,
        action: 'status_sync_from_model',
        modelId: model.id,
        status1: slot.status1,
        status2: slot.status2,
        status3: slot.status3
      });
    }

    // Link back slot -> model
    slot.modelId = model.id;

    // Sync slot.title to model.name for consistency in schedule UI
    if (model.name && slot.title !== model.name) {
      slot.history = slot.history || [];
      slot.history.push({
        ts: Date.now(),
        userId: sess.user.id,
        action: 'title_sync_from_model',
        modelId: model.id,
        oldTitle: slot.title,
        newTitle: model.name
      });
      slot.title = model.name;
    }

    await env.CRM_KV.put(`model:${model.id}`, JSON.stringify(model));
    await env.CRM_KV.put(`slot:${slot.date}:${slot.id}`, JSON.stringify(slot));

    return json({ ok: true, model, slot });
  }

  // Action: ingest slot into existing model (copy files and add interview history)
  if (body.action === 'ingestFromSlot') {
    const modelId = (body.modelId || '').trim();
    const date = (body.date || '').trim();
    const slotId = (body.slotId || '').trim();
    if (!modelId || !date || !slotId) return badRequest('modelId/date/slotId required');
    const model = await env.CRM_KV.get(`model:${modelId}`, { type: 'json' });
    if (!model) return notFound('model');
    const slot = await env.CRM_KV.get(`slot:${date}:${slotId}`, { type: 'json' });
    if (!slot) return notFound('slot');

    // Link files: scan all file metas for this slotId and create model-file metas pointing to same objectKey
    const filesList = await env.CRM_KV.list({ prefix: 'file:' });
    const metas = await Promise.all(filesList.keys.map(k => env.CRM_KV.get(k.name, { type: 'json' })));
    const slotFiles = metas.filter(f => f && f.entity === 'slot' && f.slotId === slotId);
    const linked = [];
    for (const f of slotFiles) {
      const id = newId('fil');
      const meta = { id, entity: 'model', modelId, name: f.name, description: f.description, objectKey: f.objectKey, contentType: f.contentType, size: f.size, createdAt: Date.now() };
      await env.CRM_KV.put(`file:${id}`, JSON.stringify(meta));
      // write index for faster listing
      await env.CRM_KV.put(`file_model:${modelId}:${id}`, '1');
      linked.push({ ...meta, url: `/api/files?id=${id}` });
    }

    // Merge data_block from slot into model
    try {
      const mergedDB = mergeDataBlocks(model.data_block, slot.data_block, { recordEdit: true, editedBy: sess.user.id });
      model.data_block = mergedDB;
      // Map known fields
      const fields = extractModelFieldsFromDataBlock(mergedDB);
      if (fields.fullName !== undefined) model.fullName = fields.fullName;
      if (fields.phone !== undefined) {
        model.contacts = model.contacts || {};
        model.contacts.phone = fields.phone;
      }
    } catch {}

    // Write history entry into model
    model.history = model.history || [];
    model.history.push({ ts: Date.now(), type: 'interview', slot: { id: slot.id, date: slot.date, start: slot.start, end: slot.end, title: slot.title }, text: slot.interview?.text });
    await env.CRM_KV.put(`model:${modelId}`, JSON.stringify(model));

    return json({ ok: true, linkedCount: linked.length, files: linked, model });
  }
  const name = (body.name || '').trim();
  const note = (body.note || '').trim();
  const fullName = (body.fullName || '').trim();
  const contacts = { phone: (body.phone || (body.contacts && body.contacts.phone) || '').trim() };
  const tags = Array.isArray(body.tags)
    ? Array.from(new Set(body.tags.map(t => String(t).trim()).filter(Boolean)))
    : [];
  if (!name) return badRequest('name required');
  const id = newId('mdl');
  const model = { id, name, note, fullName, contacts, tags, history: [], comments: [], mainPhotoId: null, createdAt: Date.now(), createdBy: sess.user.id };
  await env.CRM_KV.put(`model:${id}`, JSON.stringify(model));
  return json(model);
}

export async function PUT(env, request) {
  const { sess, error } = await requireRole(env, request, ['root','admin']);
  if (error) return error;
  let body; try { body = await request.json(); } catch { return badRequest('Expect JSON'); }
  // Action: immutable comments append
  if (body.action === 'addComment') {
    const modelId = (body.modelId || '').trim();
    const text = (body.text || '').trim();
    if (!modelId || !text) return badRequest('modelId and text required');
    const cur = await env.CRM_KV.get(`model:${modelId}`, { type: 'json' });
    if (!cur) return notFound('model');
    cur.comments = Array.isArray(cur.comments) ? cur.comments : [];
    const entry = { ts: Date.now(), text, user: sess && sess.user ? { id: sess.user.id, login: sess.user.login, role: sess.user.role } : null };
    cur.comments.push(entry);
    await env.CRM_KV.put(`model:${modelId}`, JSON.stringify(cur));
    return json({ ok: true, comment: entry, model: cur });
  }
  const id = body.id; if (!id) return badRequest('id required');
  const cur = await env.CRM_KV.get(`model:${id}`, { type: 'json' });
  if (!cur) return notFound('model');
  // Safely update string fields; avoid .trim() on undefined for legacy records
  const safeTrim = (v, fallback) => {
    if (v === undefined || v === null) return fallback;
    const s = String(v).trim();
    return s;
  };

  // Track name change to optionally sync linked slot title
  const prevName = typeof cur.name === 'string' ? cur.name : '';
  // Track profile field changes to decide data sync to slot
  let profileChanged = false;
  if ('name' in body) cur.name = safeTrim(body.name, typeof cur.name === 'string' ? cur.name : '');
  if ('note' in body) cur.note = safeTrim(body.note, typeof cur.note === 'string' ? cur.note : '');
  if ('fullName' in body) {
    cur.fullName = safeTrim(body.fullName, typeof cur.fullName === 'string' ? cur.fullName : '');
    cur.registration = cur.registration || {};
    cur.registration.fullName = safeTrim(body.fullName, typeof cur.registration.fullName === 'string' ? cur.registration.fullName : '');
    profileChanged = true;
  }
  if ('webcamAccounts' in body) cur.webcamAccounts = safeTrim(body.webcamAccounts, typeof cur.webcamAccounts === 'string' ? cur.webcamAccounts : '');
  if (body.contacts !== undefined) {
    cur.contacts = cur.contacts || {};
    if ('phone' in body.contacts) {
      cur.contacts.phone = safeTrim(body.contacts.phone, typeof cur.contacts.phone === 'string' ? cur.contacts.phone : '');
      profileChanged = true;
    }
  }
  if (body.tags !== undefined) {
    cur.tags = Array.isArray(body.tags)
      ? Array.from(new Set(body.tags.map(t => String(t).trim()).filter(Boolean)))
      : [];
  }
  if (body.mainPhotoId !== undefined) cur.mainPhotoId = body.mainPhotoId || null;
  
  // Handle status updates with validation
  const oldStatuses = { status1: cur.status1, status2: cur.status2, status3: cur.status3, status4: cur.status4 };
  let statusChanged = false;
  
  if (body.status1 !== undefined) {
    if (!validateStatus('status1', body.status1)) return badRequest('invalid status1');
    cur.status1 = body.status1;
    statusChanged = true;
  }
  if (body.status2 !== undefined) {
    if (!validateStatus('status2', body.status2)) return badRequest('invalid status2');
    cur.status2 = body.status2 || undefined;
    statusChanged = true;
  }
  if (body.status3 !== undefined) {
    if (!validateStatus('status3', body.status3)) return badRequest('invalid status3');
    cur.status3 = body.status3 || undefined;
    statusChanged = true;
  }
  if (body.status4 !== undefined) {
    if (!validateStatus('status4', body.status4)) return badRequest('invalid status4');
    cur.status4 = body.status4 || undefined;
    statusChanged = true;
  }
  
  // Unified data_block updates on model
  let dataChanged = false;
  if ('dataBlock' in body && body.dataBlock && typeof body.dataBlock === 'object') {
    const existingDB = normalizeDataBlock(cur.data_block);
    const mergedDB = mergeDataBlocks(existingDB, body.dataBlock, { recordEdit: true, editedBy: sess.user.id });
    if (JSON.stringify(existingDB) !== JSON.stringify(mergedDB)) dataChanged = true;
    cur.data_block = mergedDB;
    // Map to known fields
    const fields = extractModelFieldsFromDataBlock(mergedDB);
    if (fields.fullName !== undefined) cur.fullName = fields.fullName;
    if (fields.phone !== undefined) {
      cur.contacts = cur.contacts || {};
      cur.contacts.phone = fields.phone;
    }
  }
  // If profile fields changed, also reflect them into data_block so sync to slot carries them
  if (profileChanged) {
    try {
      const db0 = normalizeDataBlock(cur.data_block);
      const patch = { model_data: [] };
      if ('fullName' in body) patch.model_data.push({ field: 'fullName', value: cur.fullName || '' });
      if (body.contacts && ('phone' in body.contacts)) patch.model_data.push({ field: 'phone', value: (cur.contacts && cur.contacts.phone) || '' });
      if (patch.model_data.length) {
        const merged = mergeDataBlocks(db0, patch, { recordEdit: true, editedBy: sess.user.id });
        if (JSON.stringify(db0) !== JSON.stringify(merged)) dataChanged = true;
        cur.data_block = merged;
      }
    } catch {}
  }
  
  // Handle registration updates
  if (body.registration !== undefined) {
    cur.registration = cur.registration || {};
    if (body.registration.birthDate !== undefined) cur.registration.birthDate = body.registration.birthDate;
    if (body.registration.docType !== undefined) cur.registration.docType = body.registration.docType;
    if (body.registration.docNumber !== undefined) cur.registration.docNumber = body.registration.docNumber;
    if (body.registration.internshipDate !== undefined) cur.registration.internshipDate = body.registration.internshipDate;
    if (body.registration.comment !== undefined) cur.registration.comment = body.registration.comment;
    if (body.registration.fullName !== undefined) cur.registration.fullName = body.registration.fullName;
    if (body.registration.phone !== undefined) cur.registration.phone = body.registration.phone;
    
    // Update registration statuses snapshot if statuses were changed
    if (statusChanged) {
      cur.registration.statuses = cur.registration.statuses || {};
      if (body.status1 !== undefined) cur.registration.statuses.status1 = cur.status1;
      if (body.status2 !== undefined && cur.status2) cur.registration.statuses.status2 = cur.status2;
      if (body.status3 !== undefined && cur.status3) cur.registration.statuses.status3 = cur.status3;
      if (body.status4 !== undefined && cur.status4) cur.registration.statuses.status4 = cur.status4;
    }
  }
  
  // Add status change history if statuses changed
  if (statusChanged) {
    cur.history = cur.history || [];
    cur.history.push(createStatusChangeEntry(sess.user.id, oldStatuses, { status1: cur.status1, status2: cur.status2, status3: cur.status3, status4: cur.status4 }));
  }
  
  // Append data_block_update history if needed
  if (dataChanged) {
    cur.history = cur.history || [];
    cur.history.push({ ts: Date.now(), type: 'data_block_update', userId: sess.user.id });
  }
  await env.CRM_KV.put(`model:${id}`, JSON.stringify(cur));
  
  // Sync statuses with linked slot if status changed and model has slot reference
  if (statusChanged && cur.registration && cur.registration.slotRef) {
    try {
      const slotKey = `slot:${cur.registration.slotRef.date}:${cur.registration.slotRef.id}`;
      const slot = await env.CRM_KV.get(slotKey, { type: 'json' });
      if (slot) {
        const slotStatuses = normalizeStatuses({ status1: cur.status1, status2: cur.status2, status3: cur.status3, status4: cur.status4 });
        slot.status1 = slotStatuses.status1;
        slot.status2 = slotStatuses.status2;
        slot.status3 = slotStatuses.status3;
        slot.status4 = slotStatuses.status4;
        
        slot.history = slot.history || [];
        slot.history.push({
          ts: Date.now(),
          userId: sess.user.id,
          action: 'status_sync_from_model',
          modelId: cur.id,
          status1: slot.status1,
          status2: slot.status2,
          status3: slot.status3,
          status4: slot.status4
        });
        
        await env.CRM_KV.put(slotKey, JSON.stringify(slot));
      }
    } catch (e) {
      console.warn('Failed to sync model->slot statuses:', e);
    }
  }
  
  // Sync model data_block to linked slot if data or profile changed (model is source of truth)
  if ((dataChanged || profileChanged) && cur.registration && cur.registration.slotRef) {
    try {
      const slotKey = `slot:${cur.registration.slotRef.date}:${cur.registration.slotRef.id}`;
      const slot = await env.CRM_KV.get(slotKey, { type: 'json' });
      if (slot) {
        const currentDB = normalizeDataBlock(slot.data_block);
        const mergedFromModel = mergeDataBlocks(currentDB, cur.data_block, { recordEdit: true, editedBy: sess.user.id });
        slot.data_block = mergedFromModel;
        slot.history = slot.history || [];
        slot.history.push({ ts: Date.now(), userId: sess.user.id, action: 'data_sync_from_model', modelId: cur.id });
        await env.CRM_KV.put(slotKey, JSON.stringify(slot));
      }
    } catch (e) {
      console.warn('Failed to sync model data to slot:', e);
    }
  }

  // If model name changed, sync linked slot title to keep schedule consistent
  try {
    const nameChanged = ('name' in body) && (safeTrim(body.name, prevName) !== prevName);
    if (nameChanged && cur.registration && cur.registration.slotRef) {
      const slotKey = `slot:${cur.registration.slotRef.date}:${cur.registration.slotRef.id}`;
      const slot = await env.CRM_KV.get(slotKey, { type: 'json' });
      if (slot && slot.title !== cur.name) {
        slot.history = slot.history || [];
        slot.history.push({
          ts: Date.now(),
          userId: sess.user.id,
          action: 'title_sync_from_model',
          modelId: cur.id,
          oldTitle: slot.title,
          newTitle: cur.name
        });
        slot.title = cur.name;
        await env.CRM_KV.put(slotKey, JSON.stringify(slot));
      }
    }
  } catch (e) {
    console.warn('Failed to sync model name to slot title:', e);
  }
  
  return json(cur);
}

export async function DELETE(env, request) {
  const { sess, error } = await requireRole(env, request, ['root','admin']);
  if (error) return error;
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id) return badRequest('id required');
  const cur = await env.CRM_KV.get(`model:${id}`, { type: 'json' });
  if (!cur) return notFound('model');
  // Delete all files for this model: use index keys file_model:<modelId>:<fileId>
  const idx = await env.CRM_KV.list({ prefix: `file_model:${id}:` });
  if (idx.keys && idx.keys.length) {
    for (const k of idx.keys) {
      const fid = k.name.split(':').pop();
      const meta = await env.CRM_KV.get(`file:${fid}`, { type: 'json' });
      if (meta) {
        try { await env.CRM_FILES.delete(meta.objectKey); } catch {}
        await env.CRM_KV.delete(`file:${fid}`);
      }
      await env.CRM_KV.delete(k.name);
    }
  } else {
    // Fallback: scan all file metas and remove ones belonging to model
    const list = await env.CRM_KV.list({ prefix: 'file:' });
    for (const k of list.keys) {
      const meta = await env.CRM_KV.get(k.name, { type: 'json' });
      if (meta && meta.entity === 'model' && meta.modelId === id) {
        try { await env.CRM_FILES.delete(meta.objectKey); } catch {}
        await env.CRM_KV.delete(k.name);
        await env.CRM_KV.delete(`file_model:${id}:${meta.id}`);
      }
    }
  }

  // Unlink slot reference if present
  if (cur.registration && cur.registration.slotRef) {
    const ref = cur.registration.slotRef;
    const slotKey = `slot:${ref.date}:${ref.id}`;
    try {
      const slot = await env.CRM_KV.get(slotKey, { type: 'json' });
      if (slot && slot.modelId === id) {
        delete slot.modelId;
        await env.CRM_KV.put(slotKey, JSON.stringify(slot));
      }
    } catch {}
  }

  await env.CRM_KV.delete(`model:${id}`);
  await auditLog(env, request, sess, 'model_delete', { modelId: id });
  return json({ ok: true });
}
