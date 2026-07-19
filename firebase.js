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

// Atualiza role do usuário para 'pro' (usado também a cada renovação mensal automática)
async function upgradeUserToPro(username, paymentId) {
  await db.ref(`accounts/${username}`).update({
    role: 'pro',
    proSince: Date.now(),
    paymentId: paymentId || null,
  });
  console.log(`✅ Usuário ${username} atualizado para Pro`);
}

// Salva o e-mail e o ID da assinatura (preapproval) assim que ela é criada, ainda 'pending'
async function salvarAssinaturaPendente(username, email, preapprovalId) {
  await db.ref(`accounts/${username}`).update({
    email,
    preapprovalId,
    subscriptionStatus: 'pending',
  });
}

// Chamado quando o MP confirma que a assinatura foi autorizada pelo usuário
// (primeira cobrança feita) — ativa o Pro e marca a renovação automática como ligada
async function ativarAssinaturaPro(username, preapprovalId) {
  const ref = db.ref(`accounts/${username}`);
  const snap = await ref.once('value');
  const acc = snap.val() || {};
  const updates = {
    role: 'pro',
    preapprovalId,
    subscriptionStatus: 'authorized',
    lastRenewedAt: Date.now(),
  };
  if (!acc.proSince) updates.proSince = Date.now();
  await ref.update(updates);
  console.log(`✅ Assinatura ativada para ${username} (renovação automática ligada)`);
}

// Chamado a cada cobrança mensal aprovada — só atualiza o carimbo de renovação
async function registrarRenovacaoPro(username, cobrancaId) {
  await db.ref(`accounts/${username}`).update({
    role: 'pro',
    subscriptionStatus: 'authorized',
    lastRenewedAt: Date.now(),
    lastCobrancaId: cobrancaId || null,
  });
  console.log(`🔁 Renovação mensal registrada para ${username}`);
}

// Chamado quando a assinatura é cancelada (pelo usuário ou por falha de pagamento repetida)
async function downgradeUserToFree(username, motivo) {
  await db.ref(`accounts/${username}`).update({
    role: 'free',
    subscriptionStatus: motivo || 'cancelled',
  });
  console.log(`⬇️ Usuário ${username} voltou para Free (${motivo || 'cancelled'})`);
}

// Busca todas as contas que têm um determinado preapprovalId (usado como fallback no webhook)
async function getUserByPreapprovalId(preapprovalId) {
  const snap = await db.ref('accounts').once('value');
  const accounts = snap.val() || {};
  for (const [username, data] of Object.entries(accounts)) {
    if (data.preapprovalId === preapprovalId) {
      return { username, ...data };
    }
  }
  return null;
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

// Busca todos os usuários Pro (ou admin) que já vincularam um número de WhatsApp
// — usado pelo lembrete automático de vencimento de parcelas
async function getProUsersComWhatsapp() {
  const snap = await db.ref('accounts').once('value');
  const accounts = snap.val() || {};
  return Object.entries(accounts)
    .filter(([, data]) => (data.role === 'pro' || data.role === 'admin') && data.whatsapp)
    .map(([username, data]) => ({ username, whatsapp: data.whatsapp }));
}

// Marca uma parcela específica como "já avisada" (3 dias antes ou no dia),
// pra não mandar o mesmo lembrete de novo no dia seguinte
async function marcarLembreteEnviado(username, parcelaId, seq, tipo) {
  const ref = db.ref(`users/${username}/parc`);
  const snap = await ref.once('value');
  const arr = snap.val() || [];
  const idxParc = arr.findIndex((p) => p.id === parcelaId);
  if (idxParc === -1) return;
  const idxItem = (arr[idxParc].pars || []).findIndex((p) => p.seq === seq);
  if (idxItem === -1) return;
  const campo = tipo === '3dias' ? 'lembrete3d' : 'lembreteDia';
  arr[idxParc].pars[idxItem][campo] = true;
  await ref.set(arr);
}

module.exports = {
  db,
  getUser,
  getUserByWhatsApp,
  upgradeUserToPro,
  getUserData,
  saveLancamento,
  salvarAssinaturaPendente,
  ativarAssinaturaPro,
  registrarRenovacaoPro,
  downgradeUserToFree,
  getUserByPreapprovalId,
  getProUsersComWhatsapp,
  marcarLembreteEnviado,
};
