require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { criarPagamentoPro, getPayment } = require('./mercadopago');
const { upgradeUserToPro, getUser } = require('./firebase');
const { processarMensagem } = require('./whatsapp');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS — permite chamadas do app Fintrack
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.options('*', cors());

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    app: 'Fintrack Server',
    version: '1.0.0',
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================================
// CRIAR LINK DE PAGAMENTO MERCADO PAGO
// ============================================================
app.post('/pagamento/criar', async (req, res) => {
  try {
    const { username, email } = req.body;
    console.log('Criando pagamento para:', username);

    if (!username) {
      return res.status(400).json({ error: 'username obrigatório' });
    }

    // Verifica se usuário existe
    const user = await getUser(username);
    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    if (user.role === 'pro' || user.role === 'admin') {
      return res.status(400).json({ error: 'Usuário já é Pro' });
    }

    // Cria preferência no Mercado Pago
    const preference = await criarPagamentoPro(username, email);
    console.log('Preferência criada:', preference.id);

    res.json({
      success: true,
      preference_id: preference.id,
      init_point: preference.init_point,
      sandbox_init_point: preference.sandbox_init_point,
    });

  } catch (err) {
    console.error('Erro ao criar pagamento:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// WEBHOOK MERCADO PAGO
// ============================================================
app.post('/webhook/mercadopago', async (req, res) => {
  try {
    const { type, data } = req.body;
    console.log('Webhook MP:', type, data?.id);

    res.status(200).json({ received: true });

    if (type !== 'payment') return;

    const payment = await getPayment(data.id);
    console.log('Payment:', payment.status, '| ref:', payment.external_reference);

    if (payment.status !== 'approved') return;

    const username = payment.external_reference;
    if (!username) return;

    await upgradeUserToPro(username, data.id);
    console.log(`✅ ${username} agora é Pro!`);

  } catch (err) {
    console.error('Erro webhook MP:', err.message);
  }
});

// ============================================================
// WEBHOOK WHATSAPP
// ============================================================
app.post('/webhook/whatsapp', async (req, res) => {
  try {
    res.status(200).json({ received: true });

    const body = req.body;
    const phone = body.phone || body.from;
    const mensagem = body.text?.message || body.body || body.message;

    if (!phone || !mensagem || body.fromMe) return;

    await processarMensagem(phone, mensagem);

  } catch (err) {
    console.error('Erro webhook WhatsApp:', err.message);
  }
});

// ============================================================
// ADMIN
// ============================================================
app.get('/admin/usuarios', async (req, res) => {
  const token = req.headers.authorization;
  if (token !== `Bearer ${process.env.ADMIN_TOKEN}`) {
    return res.status(401).json({ error: 'Não autorizado' });
  }

  const { db } = require('./firebase');
  const snap = await db.ref('accounts').once('value');
  const accounts = snap.val() || {};

  const lista = Object.entries(accounts).map(([username, data]) => ({
    username,
    nome: data.n,
    role: data.role || 'free',
    whatsapp: data.whatsapp || null,
    proSince: data.proSince ? new Date(data.proSince).toLocaleDateString('pt-BR') : null,
  }));

  res.json({ total: lista.length, usuarios: lista });
});

// ============================================================
// START
// ============================================================
app.listen(PORT, () => {
  console.log(`🚀 Fintrack Server rodando na porta ${PORT}`);
  console.log(`   MP_ACCESS_TOKEN: ${process.env.MP_ACCESS_TOKEN ? '✅' : '❌ FALTANDO'}`);
  console.log(`   FIREBASE: ${process.env.FIREBASE_PROJECT_ID ? '✅' : '❌ FALTANDO'}`);
  console.log(`   APP_URL: ${process.env.APP_URL || '❌ FALTANDO'}`);
});
