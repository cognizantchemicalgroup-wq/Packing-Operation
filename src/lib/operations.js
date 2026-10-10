import { collection, doc, onSnapshot, query, runTransaction, serverTimestamp, orderBy, limit, where, getDocs, writeBatch, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { EmailAuthProvider, reauthenticateWithCredential } from 'firebase/auth';

const root = 'companies/ccpl';
export const ADMIN_EMAIL = 'rupesh.mudlar@cognizantchemical.com';
export const ALLOWED_EMAILS = [ADMIN_EMAIL, 'indra@cognizantchemical.com', 'production@cognizantchemical.com', 'qa@cognizantchemical.com', 'anzarsayyed02@gmail.com'];
export const RESET_PHRASE = 'RESET CCPL METHANOL DATA';
const path = (name) => `${root}/${name}`;
export const watchDoc = (name, callback) => onSnapshot(doc(db, path(name)), callback);
export const watchCollection = (name, callback, max = 100) => onSnapshot(query(collection(db, path(name)), orderBy('createdAt', 'desc'), limit(max)), s => callback(s.docs.map(d => ({ id: d.id, ...d.data() }))));
export const watchBatches = (callback) => onSnapshot(query(collection(db, path('batches')), orderBy('createdAt', 'desc'), limit(200)), s => callback(s.docs.map(d => ({ id: d.id, ...d.data() }))));
const stockRef = () => doc(db, path('stock/current'));
const maintenanceRef = () => doc(db, path('system/maintenance'));
const assertNotResetting = (snap) => { if (snap.exists() && snap.data().resetInProgress) throw new Error('A hard reset is in progress. Try again when it is complete.'); };
const eventRef = () => doc(collection(db, path('activity')));
const num = (n) => Number(n || 0);
const requirePositive = (n, label) => { if (!Number.isFinite(Number(n)) || Number(n) <= 0) throw new Error(`${label} must be greater than zero.`); };

export async function addInward({ item, quantity, invoiceNo, date, batchNo, user }) {
  requirePositive(quantity, 'Quantity');
  if (item !== 'bulkMethanolKg' && !Number.isInteger(num(quantity))) throw new Error('Packaging counts must be whole numbers.');
  const stock = stockRef(), event = eventRef();
  await runTransaction(db, async tx => {
    const [snap, lock] = await Promise.all([tx.get(stock), tx.get(maintenanceRef())]);
    assertNotResetting(lock);
    const data = snap.data() || {};
    const next = { ...data, [item]: num(data[item]) + num(quantity), updatedAt: serverTimestamp() };
    tx.set(stock, next, { merge: true });
    tx.set(event, { type: 'inward', item, quantity: num(quantity), invoiceNo: invoiceNo.trim(), date, batchNo: batchNo.trim(), userName: user.displayName || user.email, userId: user.uid, createdAt: serverTimestamp() });
  });
}

export async function recordBottling({ batchNo, rawKg, bottlesFilled, bottlesRejected, date, user }) {
  requirePositive(bottlesFilled, 'Bottles filled');
  if (!Number.isInteger(num(bottlesFilled)) || !Number.isInteger(num(bottlesRejected))) throw new Error('Bottle quantities must be whole numbers.');
  if (num(bottlesRejected) < 0) throw new Error('Rejected bottles cannot be negative.');
  if (num(bottlesRejected) > num(bottlesFilled)) throw new Error('Rejected bottles cannot exceed bottles filled.');
  if (!Number.isFinite(Number(rawKg)) || num(rawKg) < 0) throw new Error('Bulk methanol used must be zero or greater.');
  const safeId = batchNo.trim().replaceAll('/', '-').replaceAll(' ', '_');
  if (!safeId) throw new Error('Batch number is required.');
  const stock = stockRef(), batch = doc(db, path(`batches/${safeId}`)), event = eventRef();
  await runTransaction(db, async tx => {
    const [s, b, lock] = await Promise.all([tx.get(stock), tx.get(batch), tx.get(maintenanceRef())]);
    assertNotResetting(lock);
    if (b.exists()) throw new Error(`Batch ${batchNo} already exists. Use a new batch number.`);
    const st = s.data() || {}, usable = num(bottlesFilled) - num(bottlesRejected);
    if (num(rawKg) > num(st.bulkMethanolKg)) throw new Error(`Bulk methanol stock is short. Available: ${num(st.bulkMethanolKg).toLocaleString()} kg.`);
    if (num(bottlesFilled) > num(st.emptyBottles)) throw new Error(`Empty bottle stock is short. Available: ${num(st.emptyBottles)} bottles.`);
    tx.set(stock, { ...st, bulkMethanolKg: num(st.bulkMethanolKg) - num(rawKg), emptyBottles: num(st.emptyBottles) - num(bottlesFilled), filledBottles: num(st.filledBottles) + usable, updatedAt: serverTimestamp() }, { merge: true });
    tx.set(batch, { batchNo: batchNo.trim(), productionDate: date, rawKgUsed: num(rawKg), bottlesFilled: num(bottlesFilled), bottlesRejected: num(bottlesRejected), availableBottles: usable, packedBoxes: 0, remainingBoxes: 0, createdBy: user.uid, userName: user.displayName || user.email, createdAt: serverTimestamp() });
    tx.set(event, { type: 'bottling', batchNo: batchNo.trim(), rawKg: num(rawKg), bottlesFilled: num(bottlesFilled), bottlesRejected: num(bottlesRejected), bottlesAccepted: usable, date, userName: user.displayName || user.email, userId: user.uid, createdAt: serverTimestamp() });
  });
}

export async function packBoxes({ batchId, boxes, date, user }) {
  requirePositive(boxes, 'Boxes');
  const quantity = Math.floor(num(boxes));
  if (quantity !== num(boxes)) throw new Error('Box quantity must be a whole number.');
  const stock = stockRef(), batch = doc(db, path(`batches/${batchId}`)), event = eventRef();
  await runTransaction(db, async tx => {
    const [s, b, lock] = await Promise.all([tx.get(stock), tx.get(batch), tx.get(maintenanceRef())]);
    assertNotResetting(lock);
    if (!b.exists()) throw new Error('Selected batch was not found.');
    const st = s.data() || {}, bt = b.data(), bottleNeed = quantity * 4;
    if (num(bt.availableBottles) < bottleNeed || num(st.filledBottles) < bottleNeed) throw new Error(`Not enough filled bottles in this batch. Need ${bottleNeed}; batch has ${num(bt.availableBottles)}.`);
    const needs = { emptyBoxes: quantity, boxPlates: quantity * 2, thermocol: quantity * 2 };
    for (const [key, need] of Object.entries(needs)) if (num(st[key]) < need) throw new Error(`Packaging stock is short for ${key}: need ${need}, available ${num(st[key])}.`);
    tx.update(batch, { availableBottles: num(bt.availableBottles) - bottleNeed, packedBoxes: num(bt.packedBoxes) + quantity, remainingBoxes: num(bt.remainingBoxes) + quantity, updatedAt: serverTimestamp() });
    tx.set(stock, { ...st, filledBottles: num(st.filledBottles) - bottleNeed, emptyBoxes: num(st.emptyBoxes) - quantity, boxPlates: num(st.boxPlates) - quantity * 2, thermocol: num(st.thermocol) - quantity * 2, readyBoxes: num(st.readyBoxes) + quantity, updatedAt: serverTimestamp() }, { merge: true });
    tx.set(event, { type: 'packing', batchNo: bt.batchNo, batchId, boxes: quantity, bottles: bottleNeed, emptyBoxes: quantity, boxPlates: quantity * 2, thermocol: quantity * 2, date, userName: user.displayName || user.email, userId: user.uid, createdAt: serverTimestamp() });
  });
}

export async function dispatchSale({ invoiceNo, party, date, vehicle, lines, densityKgPerL, actualKg, user }) {
  if (!invoiceNo.trim()) throw new Error('Sales invoice number is required.');
  if (!party.trim()) throw new Error('Customer / intercompany party is required.');
  if (lines.some(x => num(x.boxes) > 0 && !Number.isInteger(num(x.boxes)))) throw new Error('Box quantities must be whole numbers.');
  const grouped = new Map();
  for (const x of lines.filter(x => num(x.boxes) > 0)) grouped.set(x.batchId, (grouped.get(x.batchId) || 0) + Math.floor(num(x.boxes)));
  const cleanLines = [...grouped].map(([batchId, boxes]) => ({ batchId, boxes }));
  if (!cleanLines.length) throw new Error('Enter boxes against at least one batch.');
  if (cleanLines.some(x => x.boxes <= 0)) throw new Error('Box quantities must be whole numbers.');
  const invoice = doc(db, path(`sales/${crypto.randomUUID()}`)), stock = stockRef(), event = eventRef();
  const batchRefs = cleanLines.map(x => doc(db, path(`batches/${x.batchId}`)));
  const duplicateInvoiceQuery = query(collection(db, path('sales')), where('invoiceNo', '==', invoiceNo.trim()));
  const liters = cleanLines.reduce((sum, x) => sum + x.boxes * 4 * 2.5, 0);
  const totalBoxes = cleanLines.reduce((sum, x) => sum + x.boxes, 0);
  const calculatedKg = liters * num(densityKgPerL);
  const kgDispatched = num(actualKg) > 0 ? num(actualKg) : calculatedKg;
  await runTransaction(db, async tx => {
    const [s, duplicates, lock, ...batchSnaps] = await Promise.all([tx.get(stock), tx.get(duplicateInvoiceQuery), tx.get(maintenanceRef()), ...batchRefs.map(r => tx.get(r))]);
    assertNotResetting(lock);
    if (duplicates.docs.some(item => !item.data().voided)) throw new Error(`Invoice ${invoiceNo.trim()} is already recorded.`);
    const st = s.data() || {};
    if (num(st.readyBoxes) < totalBoxes) throw new Error(`Ready stock is short. Available: ${num(st.readyBoxes)} boxes.`);
    const saleLines = cleanLines.map((line, i) => {
      const snap = batchSnaps[i];
      if (!snap.exists()) throw new Error(`Batch ${line.batchId} not found.`);
      const bt = snap.data();
      if (num(bt.remainingBoxes) < line.boxes) throw new Error(`Batch ${bt.batchNo} has only ${num(bt.remainingBoxes)} boxes left.`);
      tx.update(batchRefs[i], { remainingBoxes: num(bt.remainingBoxes) - line.boxes, updatedAt: serverTimestamp() });
      return { batchNo: bt.batchNo, batchId: line.batchId, boxes: line.boxes };
    });
    tx.set(stock, { ...st, readyBoxes: num(st.readyBoxes) - totalBoxes, dispatchedBoxes: num(st.dispatchedBoxes) + totalBoxes, totalKgDispatched: num(st.totalKgDispatched) + kgDispatched, updatedAt: serverTimestamp() }, { merge: true });
    const common = { invoiceNo: invoiceNo.trim(), party: party.trim(), date, vehicle: vehicle.trim(), lines: saleLines, boxes: totalBoxes, bottles: totalBoxes * 4, liters, densityKgPerL: num(densityKgPerL), calculatedKg, kgDispatched, kgSource: num(actualKg) > 0 ? 'invoice-entered' : 'calculated', userId: user.uid, userName: user.displayName || user.email, createdAt: serverTimestamp() };
    tx.set(invoice, common);
    tx.set(event, { ...common, type: 'dispatch', saleId: invoice.id });
  });
}

export async function updateDensity(density, user) {
  requirePositive(density, 'Methanol density');
  if (num(density) < 0.1 || num(density) > 2) throw new Error('Density must be between 0.1 and 2 kg/L.');
  await runTransaction(db, async tx => {
    const lock = await tx.get(maintenanceRef());
    assertNotResetting(lock);
    tx.set(doc(db, path('settings/operations')), { densityKgPerL: num(density), updatedAt: serverTimestamp(), updatedBy: user.uid }, { merge: true });
  });
}

export async function voidEntry({ eventId, reason, user }) {
  if (user.email?.toLowerCase() !== ADMIN_EMAIL) throw new Error('Only the CCPL administrator can correct or void an entry.');
  if (!reason?.trim()) throw new Error('Enter a correction reason.');
  const event = doc(db, path(`activity/${eventId}`)), stock = stockRef();
  await runTransaction(db, async tx => {
    const [ev, stSnap, lock] = await Promise.all([tx.get(event), tx.get(stock), tx.get(maintenanceRef())]);
    assertNotResetting(lock);
    if (!ev.exists()) throw new Error('Entry not found.');
    const e = ev.data(), st = stSnap.data() || {};
    if (e.voided) throw new Error('This entry has already been corrected or voided.');
    if (e.type === 'inward') {
      const available = num(st[e.item]);
      if (available < num(e.quantity)) throw new Error(`Cannot reverse this inward: only ${available} remains in stock. Make a separately approved physical stock adjustment.`);
      tx.set(stock, { ...st, [e.item]: available - num(e.quantity), updatedAt: serverTimestamp() }, { merge: true });
    } else if (e.type === 'bottling') {
      const batchId = String(e.batchNo).trim().replaceAll('/', '-').replaceAll(' ', '_'), batch = doc(db, path(`batches/${batchId}`));
      const b = await tx.get(batch);
      if (!b.exists() || num(b.data().packedBoxes) !== 0 || num(b.data().remainingBoxes) !== 0 || num(b.data().availableBottles) < num(e.bottlesAccepted)) throw new Error('This bottling batch has already been packed or changed; it cannot be safely reversed as one entry.');
      if (num(st.filledBottles) < num(e.bottlesAccepted)) throw new Error('Filled-bottle balance is too low to reverse this bottling entry.');
      tx.set(stock, { ...st, bulkMethanolKg: num(st.bulkMethanolKg) + num(e.rawKg), emptyBottles: num(st.emptyBottles) + num(e.bottlesFilled), filledBottles: num(st.filledBottles) - num(e.bottlesAccepted), updatedAt: serverTimestamp() }, { merge: true });
      tx.update(batch, { voided: true, voidReason: reason.trim(), availableBottles: 0, updatedAt: serverTimestamp() });
    } else if (e.type === 'packing') {
      const batch = doc(db, path(`batches/${e.batchId}`)), b = await tx.get(batch), bt = b.data() || {};
      if (!b.exists() || num(bt.remainingBoxes) < num(e.boxes) || num(st.readyBoxes) < num(e.boxes)) throw new Error('Some boxes from this packing entry have already been dispatched. Reverse the related outward entry first.');
      tx.update(batch, { availableBottles: num(bt.availableBottles) + num(e.bottles), packedBoxes: num(bt.packedBoxes) - num(e.boxes), remainingBoxes: num(bt.remainingBoxes) - num(e.boxes), updatedAt: serverTimestamp() });
      tx.set(stock, { ...st, filledBottles: num(st.filledBottles) + num(e.bottles), emptyBoxes: num(st.emptyBoxes) + num(e.emptyBoxes), boxPlates: num(st.boxPlates) + num(e.boxPlates), thermocol: num(st.thermocol) + num(e.thermocol), readyBoxes: num(st.readyBoxes) - num(e.boxes), updatedAt: serverTimestamp() }, { merge: true });
    } else if (e.type === 'dispatch') {
      const refs = (e.lines || []).map(line => doc(db, path(`batches/${line.batchId}`)));
      const saleRef = e.saleId ? doc(db, path(`sales/${e.saleId}`)) : null;
      const [saleSnap, ...snaps] = await Promise.all([...(saleRef ? [tx.get(saleRef)] : [Promise.resolve(null)]), ...refs.map(ref => tx.get(ref))]);
      for (let i=0;i<snaps.length;i++) if (!snaps[i].exists()) throw new Error(`Batch ${e.lines[i].batchNo} is missing; outward cannot be reversed.`);
      for (let i=0;i<snaps.length;i++) tx.update(refs[i], { remainingBoxes: num(snaps[i].data().remainingBoxes) + num(e.lines[i].boxes), updatedAt: serverTimestamp() });
      tx.set(stock, { ...st, readyBoxes: num(st.readyBoxes) + num(e.boxes), dispatchedBoxes: Math.max(0,num(st.dispatchedBoxes) - num(e.boxes)), totalKgDispatched: Math.max(0,num(st.totalKgDispatched) - num(e.kgDispatched)), updatedAt: serverTimestamp() }, { merge: true });
      if (saleRef && saleSnap?.exists()) tx.update(saleRef, { voided: true, voidReason: reason.trim(), voidedAt: serverTimestamp(), voidedBy: user.uid });
    } else {
      throw new Error('This entry type cannot be reversed from this screen.');
    }
    tx.update(event, { voided: true, voidReason: reason.trim(), voidedBy: user.uid, voidedByName: user.displayName || user.email, voidedAt: serverTimestamp() });
    const correction = doc(collection(db, path('activity')));
    tx.set(correction, { type: 'correction', originalEventId: eventId, originalType: e.type, reference: e.invoiceNo || e.batchNo || e.item || 'entry', reason: reason.trim(), userId: user.uid, userName: user.displayName || user.email, createdAt: serverTimestamp() });
  });
}

export async function hardResetOperationalData({ user, password, confirmation }) {
  if (user.email?.toLowerCase() !== ADMIN_EMAIL) throw new Error('Hard reset is restricted to the CCPL administrator account.');
  if (confirmation !== RESET_PHRASE) throw new Error(`Type exactly: ${RESET_PHRASE}`);
  if (!password) throw new Error('Enter your current password to confirm the reset.');
  await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password));
  await setDoc(maintenanceRef(), { resetInProgress:true, resetBy:user.uid, startedAt:serverTimestamp() }, { merge:true });
  try {
    for (const name of ['activity','sales','batches']) {
      const snap = await getDocs(collection(db, path(name)));
      for (let i=0;i<snap.docs.length;i+=400) {
        const batch = writeBatch(db);
        snap.docs.slice(i,i+400).forEach(item=>batch.delete(item.ref));
        await batch.commit();
      }
    }
    await setDoc(stockRef(), { bulkMethanolKg:0, emptyBottles:0, emptyBoxes:0, boxPlates:0, thermocol:0, filledBottles:0, readyBoxes:0, dispatchedBoxes:0, totalKgDispatched:0, updatedAt:serverTimestamp(), resetBy:user.uid }, { merge:false });
    const event = doc(collection(db, path('activity')));
    await setDoc(event, { type:'system_reset', reason:'Admin hard reset of operational stock, batches, sales and activity records.', userId:user.uid, userName:user.displayName||user.email, createdAt:serverTimestamp() });
  } finally {
    await setDoc(maintenanceRef(), { resetInProgress:false, completedAt:serverTimestamp(), resetBy:user.uid }, { merge:true });
  }
}
