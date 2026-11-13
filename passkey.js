// (build 3)
// Login com biometria do aparelho (passkeys / WebAuthn).
// iPhone: Face ID/Touch ID. Android: digital, rosto ou bloqueio de tela.
// A senha continua funcionando normalmente como alternativa.
const crypto = require('crypto');
const admin = require('firebase-admin');
const rateLimit = require('express-rate-limit');
const {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const { getUser, db } = require('./firebase');
const { criarTokenLogin } = require('./auth');

const RP_NAME = 'Bolso Inteligente';
const RP_ID = process.env.PASSKEY_RP_ID || 'bolsointeligenteapp.com.br';
const ORIGINS = (process.env.PASSKEY_ORIGINS ||
  'https://bolsointeligenteapp.com.br,https://www.bolsointeligenteapp.com.br')
  .split(',').map((s) => s.trim()).filter(Boolean);

const limite = rateLimit({
  windowMs: 15 * 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Muitas tentativas. Tente novamente em alguns minutos.' },
});

// Desafios ficam só na memória por 5 minutos, de uso único.
const desafios = new Map();
function guardarDesafio(dados) {
  const cid = crypto.randomBytes(16).toString('hex');
  desafios.set(cid, { ...dados, exp: Date.now() + 5 * 60 * 1000 });
  return cid;
}
function pegarDesafio(cid) {
  const d = desafios.get(cid);
  desafios.delete(cid);
  if (!d || Date.now() > d.exp) return null;
  return d;
}
setInterval(() => {
  const agora = Date.now();
  for (const [k, v] of desafios) if (agora > v.exp) desafios.delete(k);
}, 60 * 1000).unref();

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => new Uint8Array(Buffer.from(s, 'base64url'));
const USER_RE = /[.#$\[\]]/;

async function usuarioDoToken(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return null;
  try { return (await admin.auth().verifyIdToken(token)).uid; } catch (e) { return null; }
}

module.exports = function montarPasskey(app) {

  // ---------- Cadastro de uma biometria (usuário já logado) ----------
  app.post('/passkey/registrar/opcoes', limite, async (req, res) => {
    try {
      const username = await usuarioDoToken(req);
      if (!username) return res.status(401).json({ error: 'Sessão inválida. Entre de novo.' });
      const user = await getUser(username);
      if (!user) return res.status(404).json({ error: 'Conta não encontrada.' });
      const snap = await db.ref(`accounts/${username}/passkeys`).once('value');
      const existentes = Object.values(snap.val() || {});
      const options = await generateRegistrationOptions({
        rpName: RP_NAME, rpID: RP_ID,
        userID: username, userName: username, userDisplayName: user.n || username,
        attestationType: 'none',
        excludeCredentials: existentes.map((p) => ({ id: fromB64u(p.id), type: 'public-key', transports: p.transports || undefined })),
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      });
      const cid = guardarDesafio({ tipo: 'reg', username, challenge: options.challenge });
      res.json({ options, cid });
    } catch (err) {
      console.error('Erro passkey registrar/opcoes:', err.message);
      res.status(500).json({ error: 'Não foi possível iniciar agora.' });
    }
  });

  app.post('/passkey/registrar/verificar', limite, async (req, res) => {
    try {
      const username = await usuarioDoToken(req);
      if (!username) return res.status(401).json({ error: 'Sessão inválida. Entre de novo.' });
      const { cid, resposta, nome } = req.body || {};
      const d = pegarDesafio(cid);
      if (!d || d.tipo !== 'reg' || d.username !== username) {
        return res.status(400).json({ error: 'Tempo esgotado. Tente de novo.' });
      }
      const v = await verifyRegistrationResponse({
        response: resposta, expectedChallenge: d.challenge,
        expectedOrigin: ORIGINS, expectedRPID: RP_ID, requireUserVerification: true,
      });
      if (!v.verified || !v.registrationInfo) return res.status(400).json({ error: 'Não foi possível confirmar a biometria.' });
      const { credentialID, credentialPublicKey, counter } = v.registrationInfo;
      const id = b64u(credentialID);
      const reg = {
        id, publicKey: b64u(credentialPublicKey), counter: counter || 0,
        transports: (resposta.response && resposta.response.transports) || null,
        nome: String(nome || 'Este aparelho').slice(0, 40), criadoEm: Date.now(),
      };
      await db.ref(`accounts/${username}/passkeys/${id}`).set(reg);
      await db.ref(`passkeyIndex/${id}`).set(username);
      res.json({ success: true });
    } catch (err) {
      console.error('Erro passkey registrar/verificar:', err.message);
      res.status(400).json({ error: 'Não foi possível ativar a biometria.' });
    }
  });

  app.post('/passkey/listar', limite, async (req, res) => {
    try {
      const username = await usuarioDoToken(req);
      if (!username) return res.status(401).json({ error: 'Sessão inválida.' });
      const snap = await db.ref(`accounts/${username}/passkeys`).once('value');
      const lista = Object.values(snap.val() || {}).map((p) => ({ id: p.id, nome: p.nome, criadoEm: p.criadoEm }));
      res.json({ success: true, passkeys: lista });
    } catch (err) {
      res.status(500).json({ error: 'Erro ao listar.' });
    }
  });

  app.post('/passkey/remover', limite, async (req, res) => {
    try {
      const username = await usuarioDoToken(req);
      if (!username) return res.status(401).json({ error: 'Sessão inválida.' });
      const id = String((req.body || {}).id || '');
      if (!/^[A-Za-z0-9_-]{10,512}$/.test(id)) return res.status(400).json({ error: 'Identificador inválido.' });
      const ref = db.ref(`accounts/${username}/passkeys/${id}`);
      if (!(await ref.once('value')).exists()) return res.status(404).json({ error: 'Não encontrada.' });
      await ref.remove();
      await db.ref(`passkeyIndex/${id}`).remove();
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Erro ao remover.' });
    }
  });

  // ---------- Entrar com biometria ----------
  app.post('/passkey/login/opcoes', limite, async (req, res) => {
    try {
      const username = String((req.body || {}).username || '').trim();
      let allow = [];
      if (username && !USER_RE.test(username)) {
        const snap = await db.ref(`accounts/${username}/passkeys`).once('value');
        allow = Object.values(snap.val() || {}).map((p) => ({ id: fromB64u(p.id), type: 'public-key', transports: p.transports || undefined }));
      }
      const options = await generateAuthenticationOptions({
        rpID: RP_ID, userVerification: 'required', allowCredentials: allow,
      });
      const cid = guardarDesafio({ tipo: 'login', challenge: options.challenge });
      res.json({ options, cid });
    } catch (err) {
      console.error('Erro passkey login/opcoes:', err.message);
      res.status(500).json({ error: 'Não foi possível iniciar agora.' });
    }
  });

  app.post('/passkey/login/verificar', limite, async (req, res) => {
    const falha = () => res.status(400).json({ error: 'Não foi possível entrar com biometria. Use sua senha.' });
    try {
      const { cid, resposta } = req.body || {};
      const d = pegarDesafio(cid);
      if (!d || d.tipo !== 'login' || !resposta || typeof resposta.id !== 'string') return falha();
      const id = resposta.id;
      if (!/^[A-Za-z0-9_-]{10,512}$/.test(id)) return falha();
      const usernameSnap = await db.ref(`passkeyIndex/${id}`).once('value');
      const username = usernameSnap.val();
      if (!username) return falha();
      const user = await getUser(username);
      const pSnap = await db.ref(`accounts/${username}/passkeys/${id}`).once('value');
      const pk = pSnap.val();
      if (!user || !pk) return falha();
      const v = await verifyAuthenticationResponse({
        response: resposta, expectedChallenge: d.challenge,
        expectedOrigin: ORIGINS, expectedRPID: RP_ID, requireUserVerification: true,
        authenticator: { credentialID: fromB64u(pk.id), credentialPublicKey: fromB64u(pk.publicKey), counter: pk.counter || 0, transports: pk.transports || undefined },
      });
      if (!v.verified) return falha();
      await db.ref(`accounts/${username}/passkeys/${id}/counter`).set(v.authenticationInfo.newCounter || 0);
      await db.ref(`accounts/${username}/passkeys/${id}/ultimoUso`).set(Date.now());
      const token = await criarTokenLogin(username);
      res.json({ success: true, token, username, nome: user.n, role: user.role || 'free', firstAccess: !!user.firstAccess });
    } catch (err) {
      console.error('Erro passkey login/verificar:', err.message);
      falha();
    }
  });
};

