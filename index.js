require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const {
  criarPagamentoPro, getPayment,
  criarAssinaturaPro, getAssinatura, cancelarAssinatura, getCobrancaAssinatura,
} = require('./mercadopago');
const {
  upgradeUserToPro, getUser,
  salvarAssinaturaPendente, ativarAssinaturaPro, registrarRenovacaoPro,
  downgradeUserToFree, getUserByPreapprovalId,
} = require('./firebase');
const { processarMensagem } = require('./whatsapp');
const { verificarVencimentos } = require('./lembretes');
const { analisarImagem } = require('./scanner');
const { gerarToken, hashSenha, enviarEmailReset } = require('./reset');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    app: 'Fintrack Server',
    version: '1.0.0',
    endpoints: [
      'GET  /health',
      'POST /assinatura/criar',
      'POST /assinatura/cancelar',
      'POST /pagamento/criar',
      'POST /scanner/analisar',
      'POST /senha/solicitar',
      'POST /senha/redefinir',
      'POST /webhook/mercadopago',
      'POST /webhook/whatsapp',
      'POST /admin/checar-vencimentos',
    ],
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

    if (!username) {
      return res.status(400).json({ error: 'username obrigatório' });
    }

    // Verifica se usuário existe
    const user = await getUser(username);
    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    if (user.role === 'pro') {
      return res.status(400).json({ error: 'Usuário já é Pro' });
    }

    // Cria preferência no Mercado Pago
    const preference = await criarPagamentoPro(username, email);

    res.json({
      success: true,
      preference_id: preference.id,
      init_point: preference.init_point,       // URL de pagamento
      sandbox_init_point: preference.sandbox_init_point, // URL de teste
    });

  } catch (err) {
    console.error('Erro ao criar pagamento:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// CRIAR ASSINATURA RECORRENTE (renovação automática mensal)
// ============================================================
app.post('/assinatura/criar', async (req, res) => {
  try {
    const { username, email } = req.body;

    if (!username || !email) {
      return res.status(400).json({ error: 'username e email são obrigatórios' });
    }

    const user = await getUser(username);
    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    if (user.role === 'pro' || user.role === 'admin') {
      return res.status(400).json({ error: 'Usuário já é Pro' });
    }

    // Cria a assinatura no Mercado Pago (usuário autoriza uma vez, cobrança é automática depois)
    const assinatura = await criarAssinaturaPro(username, email);
    await salvarAssinaturaPendente(username, email, assinatura.id);

    res.json({
      success: true,
      preapproval_id: assinatura.id,
      init_point: assinatura.init_point,
    });

  } catch (err) {
    console.error(`Erro ao criar assinatura (username=${req.body.username}, email=${req.body.email}):`, err.message || err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// CANCELAR ASSINATURA RECORRENTE — para de cobrar automaticamente
// ============================================================
app.post('/assinatura/cancelar', async (req, res) => {
  try {
    const { username } = req.body;
    if (!username) {
      return res.status(400).json({ error: 'username obrigatório' });
    }

    const user = await getUser(username);
    if (!user || !user.preapprovalId) {
      return res.status(400).json({ error: 'Este usuário não tem assinatura ativa' });
    }

    await cancelarAssinatura(user.preapprovalId);
    await downgradeUserToFree(username, 'cancelled_by_user');

    res.json({ success: true });

  } catch (err) {
    console.error('Erro ao cancelar assinatura:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// WEBHOOK MERCADO PAGO — recebe notificação de pagamento
// ============================================================
app.post('/webhook/mercadopago', async (req, res) => {
  try {
    // MP às vezes manda "type", às vezes "topic" (formato legado) — cobrimos os dois
    const type = req.body.type || req.body.topic;
    const data = req.body.data || { id: req.query['data.id'] || req.query.id };
    console.log('Webhook MP recebido:', type, data?.id);

    // Confirma recebimento imediatamente (MP exige resposta rápida)
    res.status(200).json({ received: true });

    // ---- ASSINATURA CRIADA / ATUALIZADA (autorizada, pausada ou cancelada) ----
    if (type === 'subscription_preapproval' || type === 'preapproval') {
      const assinatura = await getAssinatura(data.id);
      const username = assinatura.external_reference;
      if (!username) {
        console.error('Assinatura sem external_reference:', data.id);
        return;
      }

      if (assinatura.status === 'authorized') {
        await ativarAssinaturaPro(username, data.id);
        console.log(`🎉 ${username} agora é Pro com renovação automática! Assinatura: ${data.id}`);
      } else if (assinatura.status === 'cancelled' || assinatura.status === 'paused') {
        await downgradeUserToFree(username, assinatura.status);
        console.log(`⏸️ Assinatura de ${username} está ${assinatura.status}`);
      }
      return;
    }

    // ---- COBRANÇA MENSAL RECORRENTE PROCESSADA ----
    if (type === 'subscription_authorized_payment') {
      const cobranca = await getCobrancaAssinatura(data.id);
      console.log('Cobrança recorrente:', cobranca.status, '| preapproval:', cobranca.preapproval_id);

      // Descobre o username a partir da assinatura vinculada
      let username = null;
      const assinatura = await getAssinatura(cobranca.preapproval_id).catch(() => null);
      if (assinatura?.external_reference) {
        username = assinatura.external_reference;
      } else {
        const user = await getUserByPreapprovalId(cobranca.preapproval_id);
        username = user?.username || null;
      }
      if (!username) {
        console.error('Cobrança sem usuário identificável:', data.id);
        return;
      }

      if (cobranca.status === 'approved' || cobranca.status === 'processed') {
        await registrarRenovacaoPro(username, data.id);
        console.log(`🔁 Renovação mensal de ${username} confirmada.`);
      } else if (cobranca.status === 'rejected') {
        // O MP tenta novamente automaticamente por alguns dias antes de cancelar a assinatura.
        // Quando ele desistir de vez, chega um webhook subscription_preapproval com status cancelled.
        console.warn(`⚠️ Cobrança recusada para ${username}. MP tentará novamente automaticamente.`);
      }
      return;
    }

    // ---- FLUXO ANTIGO: PAGAMENTO ÚNICO (mantido para compatibilidade) ----
    if (type === 'payment') {
      const payment = await getPayment(data.id);
      console.log('Payment status:', payment.status, '| ref:', payment.external_reference);

      if (payment.status !== 'approved') return;

      const username = payment.external_reference;
      if (!username) {
        console.error('Pagamento sem external_reference:', data.id);
        return;
      }

      await upgradeUserToPro(username, data.id);
      console.log(`🎉 ${username} agora é Pro! Pagamento: ${data.id}`);
    }

  } catch (err) {
    console.error('Erro no webhook MP:', err.message);
  }
});

// ============================================================
// WEBHOOK WHATSAPP (Z-API)
// ============================================================
app.post('/webhook/whatsapp', async (req, res) => {
  try {
    res.status(200).json({ received: true });

    const body = req.body;
    console.log('WhatsApp webhook:', JSON.stringify(body).slice(0, 200));

    // Z-API format
    const phone = body.phone || body.from;
    const mensagem = body.text?.message || body.body || body.message;

    if (!phone || !mensagem) return;

    // Ignora mensagens do próprio bot (enviadas por nós)
    if (body.fromMe) return;

    // Processa mensagem
    await processarMensagem(phone, mensagem);

  } catch (err) {
    console.error('Erro no webhook WhatsApp:', err.message);
  }
});

// ============================================================
// ROTA ADMIN — listar usuários (protegida)
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
    subscriptionStatus: data.subscriptionStatus || null,
    lastRenewedAt: data.lastRenewedAt ? new Date(data.lastRenewedAt).toLocaleDateString('pt-BR') : null,
  }));

  res.json({ total: lista.length, usuarios: lista });
});

// ============================================================
// SCANNER (cupom/boleto) — chama a Claude API com a chave do servidor,
// nunca exposta ao navegador. Exclusivo do plano Pro.
// ============================================================
app.post('/scanner/analisar', async (req, res) => {
  try {
    const { username, base64, mediaType, tipo } = req.body;

    if (!username || !base64 || !tipo) {
      return res.status(400).json({ error: 'username, base64 e tipo são obrigatórios' });
    }

    const user = await getUser(username);
    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    if (user.role !== 'pro' && user.role !== 'admin') {
      return res.status(403).json({ error: 'Scanner é exclusivo do plano Pro' });
    }

    const resultado = await analisarImagem(base64, mediaType || 'image/jpeg', tipo);
    res.json({ success: true, resultado });

  } catch (err) {
    console.error(`Erro no scanner (username=${req.body.username}, tipo=${req.body.tipo}):`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// RECUPERAÇÃO DE SENHA — solicitar e confirmar via e-mail
// ============================================================
app.post('/senha/solicitar', async (req, res) => {
  // Sempre responde sucesso, mesmo se o usuário não existir ou não tiver
  // e-mail — evita que alguém descubra quais usernames existem no sistema.
  res.json({ success: true });

  try {
    const { username } = req.body;
    if (!username) return;

    const user = await getUser(username);
    if (!user || !user.email) {
      console.log(`Solicitação de reset para conta sem e-mail ou inexistente: ${username}`);
      return;
    }

    const token = gerarToken();
    const { db } = require('./firebase');
    await db.ref(`accounts/${username}`).update({
      resetToken: token,
      resetTokenExp: Date.now() + 60 * 60 * 1000, // 1 hora
    });

    await enviarEmailReset(user.email, username, token);
    console.log(`✅ E-mail de recuperação enviado para ${username}`);
  } catch (err) {
    console.error('Erro ao processar solicitação de reset:', err.message);
  }
});

app.post('/senha/redefinir', async (req, res) => {
  try {
    const { username, token, novaSenha } = req.body;
    if (!username || !token || !novaSenha) {
      return res.status(400).json({ error: 'Dados incompletos' });
    }
    if (novaSenha.length < 4) {
      return res.status(400).json({ error: 'A senha deve ter pelo menos 4 caracteres' });
    }

    const user = await getUser(username);
    if (!user || !user.resetToken || user.resetToken !== token) {
      return res.status(400).json({ error: 'Link inválido ou expirado' });
    }
    if (!user.resetTokenExp || Date.now() > user.resetTokenExp) {
      return res.status(400).json({ error: 'Link expirado. Solicite um novo.' });
    }

    const { db } = require('./firebase');
    await db.ref(`accounts/${username}`).update({
      p: hashSenha(novaSenha),
      resetToken: null,
      resetTokenExp: null,
    });

    console.log(`✅ Senha redefinida para ${username}`);
    res.json({ success: true });
  } catch (err) {
    console.error('Erro ao redefinir senha:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// LEMBRETE DE VENCIMENTO — checagem manual (protegida), útil para testar
// sem esperar o horário agendado
// ============================================================
app.post('/admin/checar-vencimentos', async (req, res) => {
  const token = req.headers.authorization;
  if (token !== `Bearer ${process.env.ADMIN_TOKEN}`) {
    return res.status(401).json({ error: 'Não autorizado' });
  }
  try {
    const total = await verificarVencimentos();
    res.json({ success: true, lembretesEnviados: total });
  } catch (err) {
    console.error('Erro ao checar vencimentos:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// START
// ============================================================
app.listen(PORT, () => {
  console.log(`🚀 Fintrack Server rodando na porta ${PORT}`);
  console.log(`   MP_ACCESS_TOKEN: ${process.env.MP_ACCESS_TOKEN ? '✅ configurado' : '❌ FALTANDO'}`);
  console.log(`   FIREBASE: ${process.env.FIREBASE_PROJECT_ID ? '✅ configurado' : '❌ FALTANDO'}`);
});

// Roda todo dia às 9h (horário de Brasília) — verifica parcelas vencendo
// em 3 dias ou no próprio dia, e avisa por WhatsApp os usuários Pro.
cron.schedule('0 9 * * *', () => {
  verificarVencimentos().catch((err) => console.error('Erro no cron de vencimentos:', err.message));
}, { timezone: 'America/Sao_Paulo' });
