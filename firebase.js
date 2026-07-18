const admin = require('firebase-admin');

// Inicializa Firebase Admin
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
  });
}

const db = admin.database();

// Busca usuário pelo username
async function getUser(username) {
  const snap = await db.ref(`accounts/${username}`).once('value');
  return snap.val();
}

// Busca usuário pelo número de WhatsApp
async function getUserByWhatsApp(phone) {
  const snap = await db.ref('accounts').once('value');
  const accounts = snap.val() || {};
  for (const [username, data] of Object.entries(accounts)) {
    if (data.whatsapp === phone) {
      return { username, ...data };
    }
  }
  return null;
}

// Atualiza role do usuário para 'pro'
async function upgradeUserToPro(username, paymentId) {
  await db.ref(`accounts/${username}`).update({
    role: 'pro',
    proSince: Date.now(),
    paymentId: paymentId || null,
  });
  console.log(`✅ Usuário ${username} atualizado para Pro`);
}

// Busca dados financeiros do usuário
async function getUserData(username) {
  const snap = await db.ref(`users/${username}`).once('value');
  return snap.val();
}

// Salva um lançamento via WhatsApp
async function saveLancamento(username, tipo, dados) {
  const ref = db.ref(`users/${username}/${tipo}`);
  const snap = await ref.once('value');
  const arr = snap.val() || [];
  arr.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2),
    ...dados,
    via: 'whatsapp',
    criadoEm: Date.now(),
  });
  await ref.set(arr);
  console.log(`✅ ${tipo} salvo para ${username}`);
}

module.exports = {
  db,
  getUser,
  getUserByWhatsApp,
  upgradeUserToPro,
  getUserData,
  saveLancamento,
};
