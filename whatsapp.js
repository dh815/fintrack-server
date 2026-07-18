const axios = require('axios');
const { getUserByWhatsApp, getUserData, saveLancamento } = require('./firebase');

// Envia mensagem via WhatsApp (Z-API)
async function enviarMensagem(phone, mensagem) {
  // TODO: substituir pela sua instância Z-API
  const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE;
  const ZAPI_TOKEN = process.env.ZAPI_TOKEN;

  if (!ZAPI_INSTANCE || !ZAPI_TOKEN) {
    console.log(`[WhatsApp Mock] Para ${phone}: ${mensagem}`);
    return;
  }

  await axios.post(
    `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`,
    { phone, message: mensagem }
  );
}

// Interpreta mensagem do usuário com Claude AI
async function interpretarMensagem(mensagem, dadosUsuario) {
  const CLAUDE_KEY = process.env.CLAUDE_API_KEY;

  const contexto = dadosUsuario ? `
Dados do usuário este mês:
- Entradas: R$ ${calcTotal(dadosUsuario.ent)}
- Saídas: R$ ${calcTotal(dadosUsuario.sai)}
- Saldo: R$ ${calcTotal(dadosUsuario.ent) - calcTotal(dadosUsuario.sai)}
  ` : '';

  const resp = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      system: `Você é um assistente financeiro do app Fintrack. 
Interprete mensagens do usuário e retorne JSON.

${contexto}

Tipos de resposta:
1. Registrar saída: {"acao":"saida","desc":"descrição","val":50.00,"cat":"Alimentação","date":"2026-07-18"}
2. Registrar entrada: {"acao":"entrada","desc":"descrição","val":3000,"cat":"Salário","date":"2026-07-18"}
3. Consultar saldo: {"acao":"saldo"}
4. Consultar gastos: {"acao":"gastos"}
5. Dúvida/chat: {"acao":"chat","resposta":"sua resposta aqui"}

Categorias de saída: Alimentação, Transporte, Moradia, Saúde, Lazer, Educação, Vestuário, Assinaturas, Outros
Categorias de entrada: Salário, Freelance, Investimento, Outros

Data de hoje: ${new Date().toISOString().slice(0,10)}
Responda APENAS com JSON, sem texto adicional.`,
      messages: [{ role: 'user', content: mensagem }],
    },
    {
      headers: {
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
    }
  );

  const text = resp.data.content[0].text.trim();
  return JSON.parse(text);
}

function calcTotal(arr) {
  if (!arr) return 0;
  const hoje = new Date();
  return Object.values(arr)
    .filter(x => {
      const d = new Date(x.date);
      return d.getMonth() === hoje.getMonth() && d.getFullYear() === hoje.getFullYear();
    })
    .reduce((a, x) => a + parseFloat(x.val || 0), 0)
    .toFixed(2);
}

function fmt(val) {
  return parseFloat(val).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// Processa mensagem recebida do WhatsApp
async function processarMensagem(phone, mensagem) {
  // Limpa o número (remove +55 etc)
  const phoneClean = phone.replace(/\D/g, '').replace(/^55/, '');

  // Busca usuário pelo WhatsApp
  const usuario = await getUserByWhatsApp(phoneClean);

  if (!usuario) {
    await enviarMensagem(phone,
      `⚠️ Seu número não está vinculado ao Fintrack.\n\nAcesse o app e vá em *Minha Conta → WhatsApp* para vincular.`
    );
    return;
  }

  if (usuario.role === 'free') {
    await enviarMensagem(phone,
      `⚡ O WhatsApp Bot é exclusivo do plano *Pro*.\n\nAssine em: https://dh815.github.io/fintrack`
    );
    return;
  }

  const dadosUsuario = await getUserData(usuario.username);

  try {
    const resultado = await interpretarMensagem(mensagem, dadosUsuario);

    if (resultado.acao === 'saida') {
      await saveLancamento(usuario.username, 'sai', {
        desc: resultado.desc,
        val: resultado.val,
        cat: resultado.cat || 'Outros',
        date: resultado.date || new Date().toISOString().slice(0, 10),
      });
      await enviarMensagem(phone,
        `✅ Saída registrada!\n\n📝 ${resultado.desc}\n💸 ${fmt(resultado.val)}\n🏷️ ${resultado.cat}\n📅 ${resultado.date}`
      );

    } else if (resultado.acao === 'entrada') {
      await saveLancamento(usuario.username, 'ent', {
        desc: resultado.desc,
        val: resultado.val,
        cat: resultado.cat || 'Outros',
        date: resultado.date || new Date().toISOString().slice(0, 10),
      });
      await enviarMensagem(phone,
        `✅ Entrada registrada!\n\n📝 ${resultado.desc}\n💰 ${fmt(resultado.val)}\n🏷️ ${resultado.cat}\n📅 ${resultado.date}`
      );

    } else if (resultado.acao === 'saldo') {
      const ent = calcTotal(dadosUsuario?.ent);
      const sai = calcTotal(dadosUsuario?.sai);
      const saldo = (parseFloat(ent) - parseFloat(sai)).toFixed(2);
      await enviarMensagem(phone,
        `📊 *Resumo de ${new Date().toLocaleString('pt-BR', {month:'long'})}*\n\n💰 Entradas: ${fmt(ent)}\n💸 Saídas: ${fmt(sai)}\n📈 Saldo: ${fmt(saldo)}`
      );

    } else if (resultado.acao === 'gastos') {
      const sai = calcTotal(dadosUsuario?.sai);
      await enviarMensagem(phone,
        `💸 *Gastos de ${new Date().toLocaleString('pt-BR', {month:'long'})}*\n\nTotal: ${fmt(sai)}\n\nAcesse o app para ver o detalhamento:\nhttps://dh815.github.io/fintrack`
      );

    } else {
      await enviarMensagem(phone, resultado.resposta || 'Como posso ajudar?');
    }

  } catch (err) {
    console.error('Erro ao interpretar mensagem:', err.message);
    await enviarMensagem(phone,
      `❌ Não entendi. Tente:\n• "gastei 50 no almoço"\n• "recebi 3000 de salário"\n• "qual meu saldo?"`
    );
  }
}

module.exports = { processarMensagem, enviarMensagem };
