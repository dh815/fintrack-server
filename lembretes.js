const { getProUsersComWhatsapp, getUserData, marcarLembreteEnviado } = require('./firebase');
const { enviarMensagem } = require('./whatsapp');

function fmt(val) {
  return parseFloat(val).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function fmtData(dataISO) {
  return dataISO.split('-').reverse().join('/');
}

function hojeStr() {
  return new Date().toISOString().slice(0, 10);
}

function somarDias(dataISO, dias) {
  const d = new Date(dataISO + 'T12:00:00');
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
}

// Percorre as parcelas de todos os usuários Pro com WhatsApp vinculado e envia
// um lembrete 3 dias antes do vencimento e outro no dia do vencimento.
// Cada lembrete só é enviado uma vez (marcado no próprio registro da parcela).
async function verificarVencimentos() {
  console.log('🔔 Verificando vencimentos de parcelas...');
  const hoje = hojeStr();
  const em3Dias = somarDias(hoje, 3);
  let totalEnviados = 0;

  const usuarios = await getProUsersComWhatsapp();

  for (const usuario of usuarios) {
    try {
      const dados = await getUserData(usuario.username);
      if (!dados || !dados.parc) continue;

      for (const parcela of dados.parc) {
        if (parcela.st !== 'ativo' || !parcela.pars) continue;

        for (const item of parcela.pars) {
          if (item.pg) continue; // já paga

          if (item.date === em3Dias && !item.lembrete3d) {
            await enviarMensagem(usuario.whatsapp,
              `🔔 *Lembrete de vencimento*\n\nA parcela ${item.seq}/${parcela.pars.length} de *${parcela.name}* vence em 3 dias (${fmtData(item.date)}).\n💰 Valor: ${fmt(item.val)}`
            );
            await marcarLembreteEnviado(usuario.username, parcela.id, item.seq, '3dias');
            totalEnviados++;
          }

          if (item.date === hoje && !item.lembreteDia) {
            await enviarMensagem(usuario.whatsapp,
              `⚠️ *Vence hoje!*\n\nA parcela ${item.seq}/${parcela.pars.length} de *${parcela.name}* vence hoje (${fmtData(item.date)}).\n💰 Valor: ${fmt(item.val)}`
            );
            await marcarLembreteEnviado(usuario.username, parcela.id, item.seq, 'dia');
            totalEnviados++;
          }
        }
      }
    } catch (err) {
      console.error(`Erro ao verificar vencimentos de ${usuario.username}:`, err.message);
    }
  }

  console.log(`✅ Verificação de vencimentos concluída. Lembretes enviados: ${totalEnviados}`);
  return totalEnviados;
}

module.exports = { verificarVencimentos };
