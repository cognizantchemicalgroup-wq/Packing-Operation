import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { applicationDefault, cert, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

const accounts = [
  { email: 'rupesh.mudlar@cognizantchemical.com', role: 'admin' },
  { email: 'indra@cognizantchemical.com', role: 'staff' },
  { email: 'production@cognizantchemical.com', role: 'staff' },
  { email: 'qa@cognizantchemical.com', role: 'staff' },
  { email: 'anzarsayyed02@gmail.com', role: 'staff' },
];

async function initializeAdmin() {
  try {
    const key = JSON.parse(await readFile(new URL('../service-account.json', import.meta.url), 'utf8'));
    return initializeApp({ credential: cert(key) });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return initializeApp({ credential: applicationDefault() });
    }
    throw error;
  }
}

const app = await initializeAdmin();
const auth = getAuth(app);
const db = getFirestore(app);
const failures = [];

for (const account of accounts) {
  try {
    const password = randomBytes(32).toString('base64url');
    let user;

    try {
      const existing = await auth.getUserByEmail(account.email);
      user = await auth.updateUser(existing.uid, {
        password,
        emailVerified: true,
        displayName: account.email.split('@')[0],
      });
      console.log(`Updated Authentication account: ${account.email}`);
    } catch (error) {
      if (error.code !== 'auth/user-not-found') throw error;
      user = await auth.createUser({
        email: account.email,
        password,
        emailVerified: true,
        displayName: account.email.split('@')[0],
      });
      console.log(`Created Authentication account: ${account.email}`);
    }

    await db.doc(`companies/ccpl/users/${user.uid}`).set({
      email: account.email,
      name: user.displayName,
      role: account.role,
      active: true,
      provisionedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    console.log(`Saved Firestore profile: ${account.email}`);
  } catch (error) {
    failures.push({ email: account.email, message: error.message });
    console.error(`Provisioning failed for ${account.email}: ${error.message}`);
  }
}

await app.delete();

if (failures.length) {
  console.error(`Provisioning incomplete: ${failures.length} of ${accounts.length} accounts failed.`);
  process.exitCode = 1;
} else {
  console.log('All five accounts are provisioned. Users must reset their passwords before signing in.');
}
